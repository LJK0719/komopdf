'use client';

import { SiteNav, SiteFooter } from '@/components/navigation';
import { useI18n } from '@pdf-editor/editor/i18n';
import { supportCopy } from '@pdf-editor/editor/support-copy';

const sections = [
  ['Working with files', 'Your PDF is opened from your computer. Ordinary editing and saving do not upload it to a cloud drive. Passwords are handled on your device.'],
  ['Using AI', 'Using a text AI tool sends the selected text to the AI service. KOMO requests may also include page images and recent conversation. Web conversations are kept in the current tab; desktop tasks may send the materials needed for the requested work.'],
  ['Local preferences & recovery', 'Language preferences, service connections, document recovery and translation history are saved on this device.'],
  ['Accounts & payments', 'We use your account information for sign-in, subscriptions and support. Subscription payments are processed by Stripe.'],
  ['KolmoPDF parsing & translation', 'PDFs you choose to parse or translate are processed by KolmoPDF under its privacy policy.'],
  ['No advertising trackers', 'We do not use advertising trackers.'],
] as const;

export default function PrivacyPage() {
  const { t, locale } = useI18n(); const support = supportCopy(locale);
  return <main className="site-shell"><SiteNav /><header className="site-page-heading"><span className="site-kicker">{t('Privacy')}</span><h1>{t('Your files. Your control.')}</h1><p>{t('Opening, editing and saving your PDF happens on your device.')}</p></header>
    <article className="site-prose">{sections.map(([title, text]) => <section key={title}><h2>{t(title)}</h2><p>{t(text)}</p></section>)}<section><h2>{support.privacyTitle}</h2><p>{support.privacyText}</p></section><section><h2>{t('Questions about privacy?')}</h2><p><a href="mailto:security@komopdf.com">security@komopdf.com</a></p></section></article><SiteFooter /></main>;
}
