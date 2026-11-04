import { TOOLS, ANNOTATION_TOOL, TOOL_SHARED_COPY } from './tool-content';

export const PAGE_COPY = {
  '/': { title: 'Free PDF editor online', description: 'Edit PDF text and images, organize pages and export files locally in your browser. Free PDF tools without an account.' },
  '/download/': { title: 'Download', description: 'Open the web editor to get started. Install the desktop app for offline editing, folders and text recognition.' },
  '/help/': { title: 'Help', description: 'Open a document, choose a tool and keep your work moving. Here are the essentials for web and desktop.' },
  '/privacy/': { title: 'Privacy', description: 'Opening, editing and saving your PDF happens on your device.' },
  '/pricing/': { title: 'Free PDF tools. More with KOMO.', description: 'Edit PDFs for free, without an account. Sign in for KOMO, or choose Plus for unlimited conversations.' },
  '/tools/': { title: TOOL_SHARED_COPY.title, description: TOOL_SHARED_COPY.description },
} as const;

// Canonical source-key inventory for website-specific translations. Existing help,
// privacy, download and account copy continues to use the shared UI dictionaries.
export const SITE_SOURCE_MESSAGES: readonly string[] = [...new Set([
  ...Object.values(PAGE_COPY).flatMap(copy => [copy.title, copy.description]),
  ...Object.values(TOOL_SHARED_COPY),
  ...[...TOOLS, ANNOTATION_TOOL].flatMap(tool => [tool.title, tool.description, tool.intro, tool.cta,
    ...tool.steps.flatMap(step => [step.title, step.text]), ...tool.limits,
    ...tool.faq.flatMap(item => [item.question, item.answer])]),
  'Home page', 'Download app', 'Tools', 'Pricing', 'Language', 'Main navigation', 'Footer navigation', 'Navigation menu', 'Open editor',
  'Your komopdf account', 'Use KOMO and manage your plan across web and desktop.', 'Use another account',
  'Free PDF tools. More with KOMO.', 'Choose your KOMO plan', 'PDF editing stays free.',
  'Free plan', 'For everyday PDF work', '/ forever', 'All PDF editing tools', 'No account for PDF editing',
  '1,000 welcome credits', 'KOMO conversations with credits', 'Welcome credits are added when you create an account.',
  'Create your account', 'For more work with KOMO', '/ month', 'Unlimited KOMO conversations', 'Web and desktop access',
  'Cancel anytime', 'Billed monthly in USD.', 'Sign in to upgrade',
  'KolmoPDF parsing and layout-preserving translation use your separate KolmoPDF account balance, not KOMO credits or Plus.',
  'Normal request-size and concurrency limits still apply to KOMO Plus.',
  'One credit equals 10,000 input and output tokens. Welcome credits are granted once, not every month.',
])];
