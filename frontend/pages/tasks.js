/* ════════════════════════════════════════
   pages/tasks.js — Tasks Tab
   ════════════════════════════════════════ */

async function loadTasksPage() {
  document.getElementById('page-tasks').innerHTML =
    '<div class="loading-pulse">Loading tasks...</div>';

  try {
    const data = await apiGetTasks();
    if (data.success) {
      State.tasks = data.tasks || [];
      renderTasksPage();
    }
  } catch {
    renderTasksPage(); // show demo tasks
  }
}

function renderTasksPage() {
  const completed = State.user?.completed_tasks || [];
  const tasks     = State.tasks;

  const categories = {
    channel: { label: 'Join Channel',   icon: '📢' },
    group:   { label: 'Join Group',     icon: '👥' },
    game:    { label: 'Play Game Bot',  icon: '🎮' },
    visit:   { label: 'Visit Website',  icon: '🌐' },
  };

  let html = '';

  Object.entries(categories).forEach(([type, meta]) => {
    const list = tasks.filter(t => t.type === type);
    if (!list.length) return;

    html += `<div class="task-category-label">${meta.label}</div>`;

    list.forEach(task => {
      const done = completed.includes(task.id);
      html += `
        <div class="adtask ${done ? 'done' : ''}" id="task_${task.id}">
          <div class="adtask-header">
            <div class="adtask-name">${meta.icon} ${task.name}</div>
            <div class="adtask-type-badge">${type}</div>
          </div>
          <div class="progress-bar" style="display:none" id="bar_${task.id}">
            <div class="progress-fill" id="fill_${task.id}"></div>
          </div>
          <div class="adtask-footer">
            <div class="adtask-reward">+${task.reward} TR &nbsp;+1 Spin</div>
            <div class="adtask-progress">${task.completed}/${task.limit}</div>
            ${done
              ? '<div class="adtask-done-badge">✓ Done</div>'
              : `<button class="btn btn-gold adtask-btn"
                   id="btn_${task.id}"
                   onclick="startTask('${task.id}','${type}','${task.url}',${task.reward})">
                   Start
                 </button>`}
          </div>
        </div>`;
    });
  });

  if (!html) {
    html = '<div class="empty-state">No tasks available yet.<br>Check back soon!</div>';
  }

  document.getElementById('page-tasks').innerHTML = html;
}

// ── TASK FLOW ─────────────────────────────

function startTask(taskId, type, url, reward) {
  if (type === 'channel' || type === 'group') {
    openVerifyOverlay({ id: taskId, url, reward }, type);
    return;
  }

  // Visit / Game — open URL then countdown
  if (tg) tg.openLink(url);
  else    window.open(url, '_blank');

  const duration = type === 'game' ? 10 : 15;
  const btn      = document.getElementById('btn_' + taskId);
  const bar      = document.getElementById('bar_' + taskId);
  const fill     = document.getElementById('fill_' + taskId);

  if (btn)  btn.disabled = true;
  if (bar)  bar.style.display = 'block';

  let elapsed = 0;
  const interval = setInterval(() => {
    elapsed++;
    const pct = (elapsed / duration) * 100;
    if (fill) fill.style.width = pct + '%';
    if (btn)  btn.textContent  = `${duration - elapsed}s...`;

    if (elapsed >= duration) {
      clearInterval(interval);
      if (btn) {
        btn.disabled   = false;
        btn.textContent = 'Claim!';
        btn.onclick     = () => claimAdTask(taskId, reward, btn);
      }
    }
  }, 1000);
}

async function claimAdTask(taskId, reward, btn) {
  if (btn) btn.disabled = true;
  try {
    const data = await apiClaimTask(taskId);
    if (data.success) {
      if (data.user) State.user = data.user;
      else {
        State.user.coins = (State.user.coins || 0) + reward;
        State.user.spins = (State.user.spins || 0) + 1;
        State.user.completed_tasks = [...(State.user.completed_tasks || []), taskId];
      }
      renderHome();
      renderTasksPage();
      toast(`+${reward} TR Claimed! 🎉`, 'success');
    } else {
      toast(data.error || 'Claim failed', 'error');
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    toast(err.message || 'Network error', 'error');
    if (btn) btn.disabled = false;
  }
}