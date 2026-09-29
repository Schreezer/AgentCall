(() => {
  const tabs = Array.from(document.querySelectorAll('.route-tab'));
  const panels = new Map(Array.from(document.querySelectorAll('.route-panel')).map(panel => [panel.id.slice('panel-'.length), panel]));
  if (!tabs.length || !panels.size) return;

  function activate(tab, moveFocus = false) {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.classList.toggle('is-active', selected);
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      const panel = panels.get(candidate.dataset.panel);
      if (panel) {
        panel.classList.toggle('is-active', selected);
        panel.hidden = !selected;
      }
    }
    if (moveFocus) tab.focus();
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      if (event.key === 'Home') next = tabs[0];
      if (event.key === 'End') next = tabs[tabs.length - 1];
      if (next) {
        event.preventDefault();
        activate(next, true);
      }
    });
  }
  activate(tabs.find(tab => tab.classList.contains('is-active')) || tabs[0]);
})();
