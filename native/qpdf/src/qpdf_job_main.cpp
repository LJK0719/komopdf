#include <qpdf/JSON.hh>
#include <qpdf/QPDF.hh>
#include <qpdf/QPDFWriter.hh>

#include <algorithm>
#include <cstdint>
#include <exception>
#include <iostream>
#include <iterator>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

namespace
{
struct Permissions
{
    bool accessibility{true};
    bool extract{true};
    bool assemble{true};
    bool annotate_and_form{true};
    bool form_filling{true};
    bool modify_other{true};
    qpdf_r3_print_e print{qpdf_r3p_full};
};

struct Job
{
    std::string operation;
    std::string input_file;
    std::string output_file;
    std::string input_password;
    std::string user_password;
    std::string owner_password;
    bool has_input_password{false};
    bool has_user_password{false};
    bool has_owner_password{false};
    bool encrypt_metadata{true};
    Permissions permissions;
};

using Dict = std::map<std::string, JSON>;

Dict as_dictionary(JSON const& value, char const* label)
{
    Dict result;
    if (!value.forEachDictItem([&result](std::string const& key, JSON item) {
            result.emplace(key, item);
        })) {
        throw std::runtime_error(std::string(label) + " must be a JSON object");
    }
    return result;
}

void reject_unknown(Dict const& values, std::set<std::string> const& allowed, char const* label)
{
    for (auto const& [key, value]: values) {
        (void)value;
        if (allowed.count(key) == 0) {
            throw std::runtime_error(std::string("unknown ") + label + " key: " + key);
        }
    }
}

std::string require_string(Dict const& values, std::string const& key)
{
    auto item = values.find(key);
    std::string result;
    if ((item == values.end()) || !item->second.getString(result)) {
        throw std::runtime_error(key + " must be a string");
    }
    return result;
}

bool optional_string(Dict const& values, std::string const& key, std::string& result)
{
    auto item = values.find(key);
    if (item == values.end()) {
        return false;
    }
    if (!item->second.getString(result)) {
        throw std::runtime_error(key + " must be a string");
    }
    return true;
}

bool optional_bool(Dict const& values, std::string const& key, bool fallback)
{
    auto item = values.find(key);
    if (item == values.end()) {
        return fallback;
    }
    bool result = false;
    if (!item->second.getBool(result)) {
        throw std::runtime_error(key + " must be a boolean");
    }
    return result;
}

Permissions parse_permissions(JSON const& value)
{
    Permissions result;
    Dict values = as_dictionary(value, "permissions");
    reject_unknown(
        values,
        {"accessibility", "extract", "assemble", "annotateAndForm", "formFilling",
         "modifyOther", "print"},
        "permissions");
    result.accessibility = optional_bool(values, "accessibility", true);
    result.extract = optional_bool(values, "extract", true);
    result.assemble = optional_bool(values, "assemble", true);
    result.annotate_and_form = optional_bool(values, "annotateAndForm", true);
    result.form_filling = optional_bool(values, "formFilling", true);
    result.modify_other = optional_bool(values, "modifyOther", true);

    auto print = values.find("print");
    if (print != values.end()) {
        std::string mode;
        if (!print->second.getString(mode)) {
            throw std::runtime_error("permissions.print must be a string");
        }
        if (mode == "full") {
            result.print = qpdf_r3p_full;
        } else if (mode == "low") {
            result.print = qpdf_r3p_low;
        } else if (mode == "none") {
            result.print = qpdf_r3p_none;
        } else {
            throw std::runtime_error("permissions.print must be full, low, or none");
        }
    }
    return result;
}

Job parse_job(std::string const& text)
{
    JSON root = JSON::parse(text);
    Dict values = as_dictionary(root, "job");
    reject_unknown(
        values,
        {"operation", "inputFile", "outputFile", "inputPassword", "userPassword",
         "ownerPassword", "encryptMetadata", "permissions"},
        "job");

    Job job;
    job.operation = require_string(values, "operation");
    job.input_file = require_string(values, "inputFile");
    job.output_file = require_string(values, "outputFile");
    job.has_input_password = optional_string(values, "inputPassword", job.input_password);
    job.has_user_password = optional_string(values, "userPassword", job.user_password);
    job.has_owner_password = optional_string(values, "ownerPassword", job.owner_password);
    job.encrypt_metadata = optional_bool(values, "encryptMetadata", true);
    auto permissions = values.find("permissions");
    if (permissions != values.end()) {
        job.permissions = parse_permissions(permissions->second);
    }

    if ((job.operation != "decrypt") && (job.operation != "encrypt-aes256") &&
        (job.operation != "optimize-lossless")) {
        throw std::runtime_error(
            "operation must be decrypt, encrypt-aes256, or optimize-lossless");
    }
    if (job.input_file.empty() || job.output_file.empty()) {
        throw std::runtime_error("inputFile and outputFile must not be empty");
    }
    if ((job.operation == "encrypt-aes256") &&
        (!job.has_user_password || !job.has_owner_password)) {
        throw std::runtime_error(
            "encrypt-aes256 requires explicit userPassword and ownerPassword strings");
    }
    return job;
}

void execute_job(Job const& job)
{
    QPDF pdf;
    pdf.processFile(
        job.input_file.c_str(), job.has_input_password ? job.input_password.c_str() : nullptr);

    QPDFWriter writer(pdf, job.output_file.c_str());
    if (job.operation == "decrypt") {
        writer.setPreserveEncryption(false);
    } else if (job.operation == "encrypt-aes256") {
        writer.setR6EncryptionParameters(
            job.user_password.c_str(),
            job.owner_password.c_str(),
            job.permissions.accessibility,
            job.permissions.extract,
            job.permissions.assemble,
            job.permissions.annotate_and_form,
            job.permissions.form_filling,
            job.permissions.modify_other,
            job.permissions.print,
            job.encrypt_metadata);
    } else {
        writer.setObjectStreamMode(qpdf_o_generate);
        writer.setCompressStreams(true);
        writer.setDecodeLevel(qpdf_dl_generalized);
        writer.setRecompressFlate(true);
        writer.setPreserveUnreferencedObjects(false);
    }
    writer.write();
}
} // namespace

int main(int argc, char* argv[])
{
    if ((argc == 2) && (std::string(argv[1]) == "--version")) {
        std::cout << "pdf-editor-qpdf abi=1 qpdf=" << QPDF::QPDFVersion() << '\n';
        return 0;
    }
    if (argc != 1) {
        std::cerr << "pdf-editor-qpdf: jobs are accepted only as JSON on standard input\n";
        return 2;
    }

    try {
        std::string job_text{
            std::istreambuf_iterator<char>{std::cin}, std::istreambuf_iterator<char>{}};
        if (job_text.empty()) {
            throw std::runtime_error("expected one JSON job on standard input");
        }
        Job job = parse_job(job_text);
        std::fill(job_text.begin(), job_text.end(), '\0');
        execute_job(job);
        return 0;
    } catch (std::exception const& error) {
        std::cerr << "pdf-editor-qpdf: " << error.what() << '\n';
        return 2;
    } catch (...) {
        std::cerr << "pdf-editor-qpdf: unknown failure\n";
        return 2;
    }
}
