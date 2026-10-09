/* WEGLOW site settings — shared by the main site and the manager page. */
window.WEGLOW_CONFIG = {
  whatsapp: '77089018088',          // number for orders and requests (digits only)
  phone: '+77089018088',            // phone shown in the footer
  phoneText: '+7 708 901 80 88',
  // Payments API (Supabase Edge Function `pay`), e.g. https://<ref>.supabase.co/functions/v1/pay
  // Empty = online payment is off and orders go to WhatsApp.
  payApi: ''
};
