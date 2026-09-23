const tailwindcss = require('tailwindcss');

module.exports = function conditionalTailwind(options) {
  const tw = tailwindcss(options);
  return {
    postcssPlugin: 'conditional-tailwind',
    async Once(root, helpers) {
      const file = root.source && root.source.input && root.source.input.file;
      if (file && (file.includes('packages/editor') || file.includes('packages\\editor'))) {
        return;
      }
      for (const p of tw.plugins) {
        await p(root, helpers.result);
      }
    },
  };
};
module.exports.postcss = true;
