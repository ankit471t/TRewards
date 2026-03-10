/**
 * wheel.js
 * Canvas-based animated spin wheel with physics easing
 */

class SpinWheel {
  constructor(canvas, segments) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.segments = segments || [10, 50, 80, 100, 300, 500];
    this.numSegments = this.segments.length;
    this.rotation = 0;
    this.targetRotation = 0;
    this.spinning = false;
    this.animFrame = null;
    this.onComplete = null;

    // Colors alternating gold theme
    this.colors = [
      '#FFB800', '#CC7700',
      '#FFD454', '#A05800',
      '#FFC820', '#8B4500',
    ];

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.draw();
  }

  resize() {
    const size = Math.min(this.canvas.parentElement?.offsetWidth || 300, 300);
    this.canvas.width = size;
    this.canvas.height = size;
    this.cx = size / 2;
    this.cy = size / 2;
    this.radius = size / 2 - 10;
    this.draw();
  }

  draw() {
    const { ctx, cx, cy, radius, segments, numSegments, colors, rotation } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const segAngle = (2 * Math.PI) / numSegments;

    // Draw wheel shadow
    ctx.save();
    ctx.shadowColor = 'rgba(255, 184, 0, 0.4)';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 5, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(255,184,0,0.1)';
    ctx.fill();
    ctx.restore();

    // Draw segments
    segments.forEach((seg, i) => {
      const startAngle = rotation + i * segAngle - Math.PI / 2;
      const endAngle = startAngle + segAngle;

      // Segment fill
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();

      // Segment border
      ctx.strokeStyle = 'rgba(10, 8, 0, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Text
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(startAngle + segAngle / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = i % 2 === 0 ? '#0A0800' : '#FFD454';
      ctx.font = `bold ${Math.max(11, radius * 0.12)}px "Orbitron", monospace`;
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 4;
      ctx.fillText(`+${seg}`, radius - 12, 5);
      ctx.restore();
    });

    // Center circle
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.18);
    gradient.addColorStop(0, '#FFD454');
    gradient.addColorStop(1, '#CC9200');
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.18, 0, 2 * Math.PI);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = '#0A0800';
    ctx.lineWidth = 3;
    ctx.stroke();

    // TR logo in center
    ctx.fillStyle = '#0A0800';
    ctx.font = `bold ${Math.max(10, radius * 0.1)}px "Orbitron", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TR', cx, cy);

    // Pointer (triangle at top)
    ctx.save();
    ctx.translate(cx, 0);
    ctx.fillStyle = '#FFB800';
    ctx.strokeStyle = '#0A0800';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.lineTo(-12, 22);
    ctx.lineTo(12, 22);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = '#FFB800';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Decorative dots
    for (let i = 0; i < numSegments; i++) {
      const angle = rotation + i * segAngle - Math.PI / 2;
      const dotX = cx + (radius - 8) * Math.cos(angle);
      const dotY = cy + (radius - 8) * Math.sin(angle);
      ctx.beginPath();
      ctx.arc(dotX, dotY, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#0A0800';
      ctx.fill();
    }
  }

  spin(resultIndex) {
    if (this.spinning) return;
    this.spinning = true;

    const segAngle = (2 * Math.PI) / this.numSegments;
    // Calculate rotation to land on resultIndex
    // Pointer is at top (- Math.PI/2), so we need resultIndex segment centered under pointer
    const targetAngle = -segAngle * resultIndex - segAngle / 2;
    // Add 5 full rotations for effect
    const fullSpins = (5 + Math.random() * 3) * 2 * Math.PI;
    this.targetRotation = this.rotation + fullSpins + targetAngle - (this.rotation % (2 * Math.PI));

    const startTime = performance.now();
    const duration = 4000 + Math.random() * 1500; // 4-5.5 seconds
    const startRotation = this.rotation;
    const totalDelta = this.targetRotation - startRotation;

    const ease = (t) => {
      // Cubic ease-out for deceleration feel
      return 1 - Math.pow(1 - t, 3);
    };

    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      this.rotation = startRotation + totalDelta * ease(progress);
      this.draw();

      if (progress < 1) {
        this.animFrame = requestAnimationFrame(animate);
      } else {
        this.rotation = this.targetRotation;
        this.spinning = false;
        this.draw();
        if (this.onComplete) this.onComplete(this.segments[resultIndex]);
      }
    };

    this.animFrame = requestAnimationFrame(animate);
  }

  getSegmentForValue(value) {
    return this.segments.indexOf(value);
  }

  destroy() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    window.removeEventListener('resize', this.resize);
  }
}

if (typeof window !== 'undefined') {
  window.SpinWheel = SpinWheel;
}