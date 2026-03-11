/* ════════════════════════════════════════
   wheel.js — Canvas Spin Wheel
   ════════════════════════════════════════ */

const WHEEL_COLORS  = ['#1A1200','#241800','#1C1500','#211900','#2A2000','#302500'];
const WHEEL_BORDERS = ['#FFB800','#FFD454','#CC9200','#FFB800','#FFD454','#CC9200'];

function drawWheel(highlightIndex = -1, rotation = 0) {
  const canvas = document.getElementById('wheel');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r  = cx - 4;
  const prizes = CONFIG.SPIN_PRIZES;
  const seg  = (Math.PI * 2) / prizes.length;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  prizes.forEach((prize, i) => {
    const start = rotation + i * seg - Math.PI / 2;
    const end   = start + seg;

    // Segment fill
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = highlightIndex === i ? '#3A2A00' : WHEEL_COLORS[i];
    ctx.fill();
    ctx.strokeStyle = WHEEL_BORDERS[i];
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + seg / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle  = '#FFD454';
    ctx.font = "bold 13px 'Orbitron', monospace";
    ctx.fillText(prize, r - 12, 5);
    ctx.restore();
  });

  // Center circle
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22);
  grad.addColorStop(0, '#221A00');
  grad.addColorStop(1, '#0A0800');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = '#FFB800';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#FFB800';
  ctx.font = "bold 9px 'Orbitron', monospace";
  ctx.textAlign = 'center';
  ctx.fillText('TR', cx, cy + 4);
}

async function doSpin() {
  if (State.spinning) return;
  const u = State.user;
  if (!u || (u.spins || 0) <= 0) {
    toast('No spins available! Complete tasks to earn spins.', 'error');
    return;
  }

  State.spinning = true;
  const btn = document.getElementById('spinBtn');
  if (btn) btn.disabled = true;

  try {
    const data = await apiSpin();
    if (!data.success) throw new Error(data.error || 'Spin failed');

    const prizes  = CONFIG.SPIN_PRIZES;
    const seg     = (Math.PI * 2) / prizes.length;
    const target  = data.segmentIndex;
    const landing = -(target * seg + seg / 2);
    const total   = Math.PI * 2 * 6 + landing; // 6 full spins
    const dur     = 3200;
    const t0      = performance.now();
    let   rot     = 0;

    function frame(now) {
      const p    = Math.min((now - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - p, 4);
      rot = total * ease;
      drawWheel(-1, rot);

      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        drawWheel(target, rot);
        if (data.user) State.user = data.user;
        else {
          State.user.coins += data.prize;
          State.user.spins  = Math.max(0, State.user.spins - 1);
        }
        renderHome();
        toast(`🎰 You won ${data.prize} TR!`, 'success');
        State.spinning = false;
        if (btn) btn.disabled = false;
      }
    }

    requestAnimationFrame(frame);

  } catch (err) {
    toast(err.message || 'Spin failed', 'error');
    State.spinning = false;
    if (btn) btn.disabled = false;
  }
}