'use client';
import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { MessageSquare } from 'lucide-react';
import { useI18n } from '@pdf-editor/editor/i18n';
import { supportCopy } from '@pdf-editor/editor/support-copy';
import '@pdf-editor/editor/support.css';
const CustomerSession = dynamic(() => import('./support-session').then(module => module.SupportCustomerSession), { ssr: false });
const AdminSession = dynamic(() => import('./support-session').then(module => module.SupportAdminSession), { ssr: false });
export function SupportWidget() {
  const { locale } = useI18n(); const [open, setOpen] = useState(false); const [loaded, setLoaded] = useState(false); const [mounted, setMounted] = useState(false); const c = supportCopy(locale);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => { const listener = () => { setLoaded(true); setOpen(true); }; window.addEventListener('komo-support-open', listener); return () => window.removeEventListener('komo-support-open', listener); }, []);
  return <><button type="button" className="komo-support-launcher" disabled={!mounted} aria-label={c.open} title={c.open} onClick={() => { setLoaded(true); setOpen(true); }}><MessageSquare size={20} /></button>{loaded ? <CustomerSession open={open} close={() => setOpen(false)} /> : null}</>;
}
export function SupportAdmin() { return <AdminSession />; }
export function SupportHelpButton() {
  const { locale } = useI18n(); const [ready,setReady] = useState(false); useEffect(() => { setReady(true); }, []);
  return <button type="button" disabled={!ready} className="site-button site-button-primary" onClick={() => window.dispatchEvent(new Event('komo-support-open'))}>{supportCopy(locale).open}</button>;
}
