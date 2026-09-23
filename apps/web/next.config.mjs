import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'dist',
  trailingSlash: true,
  experimental: {
    useTypeScriptCli: true,
  },
  images: {
    unoptimized: true,
  },
  transpilePackages: [
    '@pdf-editor/contracts',
    '@pdf-editor/commands',
    '@pdf-editor/ai-client',
    '@pdf-editor/editor',
  ],
  webpack: (config) => {
    config.resolve.alias['@'] = fileURLToPath(new URL('./src', import.meta.url));
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
