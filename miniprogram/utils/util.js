function money(fen) {
  return ((Number(fen) || 0) / 100).toFixed(2);
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function minutes(seconds) {
  return Math.max(1, Math.round((Number(seconds) || 0) / 60));
}

function dateLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(title, icon = 'none') {
  wx.showToast({ title: String(title).slice(0, 18), icon, duration: 2000 });
}

module.exports = { money, mmss, minutes, dateLabel, toast };
