(() => {
  const modes = {
    quick: {rounds:1,label:'QUICK COUNCIL',title:'先拿到一组独立的第二意见。',description:'适合小范围判断、快速求证；没有交叉评阅轮次。'},
    normal: {rounds:2,label:'STANDARD COUNCIL',title:'一次独立思考，一次交叉评阅。',description:'架构选择、需求歧义与重要变更的默认讨论深度。'},
    critical: {rounds:3,label:'CRITICAL COUNCIL',title:'多一次对照，正常调用用满预算。',description:'适合确需第三轮追问的决策；12 次正常调用用满预算，无额外重试或纠错额度。'},
  };
  const byId = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll('[data-mode]')];
  function select(mode) {
    const data = modes[mode];
    const calls = data.rounds * 4;
    tabs.forEach(tab => {
      const active = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    byId('mode-panel').setAttribute('aria-labelledby', 'tab-' + mode);
    byId('mode-label').textContent = data.label;
    byId('round-label').textContent = data.rounds + (data.rounds === 1 ? ' ROUND' : ' ROUNDS');
    byId('mode-title').textContent = data.title;
    byId('mode-description').textContent = data.description;
    byId('normal-calls').textContent = calls;
    byId('extra-calls').textContent = 12 - calls;
    byId('timeout').replaceChildren(document.createTextNode(String(data.rounds * 300)), Object.assign(document.createElement('span'), {textContent:'s'}));
    byId('budget').setAttribute('aria-label', `12 次预算中正常调用占 ${calls} 次，其余 ${12 - calls} 次用于重试或纠错`);
    [...byId('budget').children].forEach((segment, index) => segment.classList.toggle('used', index < calls));
    byId('command').textContent = `/council --rounds ${data.rounds} 评估当前架构与参数`;
    byId('copy-status').textContent = '';
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab.dataset.mode));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); select(tabs[next].dataset.mode); tabs[next].focus(); }
    });
  });
  byId('copy-command').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(byId('command').textContent);
      byId('copy-status').textContent = '已复制。请在 OpenCode 中执行此命令。';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(byId('command'));
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      byId('copy-status').textContent = '命令已选中，请手动复制。';
    }
  });
})();
