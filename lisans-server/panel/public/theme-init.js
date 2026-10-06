// Tema titremesini önlemek için ilk boyamadan önce uygulanır. Harici dosyadır: satır içi betik,
// üretimde API'nin gönderdiği CSP (script-src 'self') tarafından engellenirdi.
try {
  var t = localStorage.getItem('theme');
  var dark = t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {}
