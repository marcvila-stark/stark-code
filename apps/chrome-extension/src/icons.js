const icons = {
  arrow: '<path d="M9 5l6 7-6 7"/>',
  back: '<path d="M15 5l-6 7 6 7"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  quote: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  chat: '<path d="M20 15a3 3 0 0 1-3 3H9l-5 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  link: '<path d="M14 4h6v6M20 4 9 15M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.4"/><path d="m4 18 5-5 4 4 3-6 5 6"/>',
  crop: '<path d="M8 3v13h13M3 8h13v13"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
export const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[n] || icons.chat}</svg>`;
export const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
