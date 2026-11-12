import './style.css';

const DEADLINE = new Date('2026-11-30T18:00:00+08:00');

const app = document.querySelector<HTMLDivElement>('#app')!;

const pad = (n: number): string => String(n).padStart(2, '0');

function render(): void {
  const diff = DEADLINE.getTime() - Date.now();
  const text =
    diff <= 0
      ? '投稿窗口已关闭'
      : `${Math.floor(diff / 86400000)} 天 ${pad(Math.floor(diff / 3600000) % 24)} 时 ${pad(
          Math.floor(diff / 60000) % 60,
        )} 分 ${pad(Math.floor(diff / 1000) % 60)} 秒`;
  app.innerHTML = `
    <main class="card">
      <h1>2026 Qoder 高校创造力大赛 · 作品脚手架</h1>
      <p class="track">赛道:StudyHack 学习科研(选题待定)</p>
      <p class="countdown">距作品投稿截止<br /><strong>${text}</strong></p>
      <p class="hint">截止:2026-11-30 18:00 · 天池赛题页论坛</p>
    </main>`;
}

render();
setInterval(render, 1000);
