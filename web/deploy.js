function selectCommand(command) {
  command.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(command);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.hidden = false;
  const originalLabel = button.textContent;
  const command = document.getElementById(button.dataset.copy);
  const feedback = button.closest(".command-block")?.querySelector(".copy-feedback");
  if (!command) { button.hidden = true; continue; }
  let resetTimer;
  button.addEventListener("click", async () => {
    clearTimeout(resetTimer);
    button.disabled = true;
    let copied = false;
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command.textContent.trim());
        copied = true;
      }
    } catch { /* A denied clipboard operation still permits selecting the command. */ }
    if (copied) {
      button.textContent = "已复制";
      if (feedback) feedback.textContent = "命令已复制。在服务器终端中粘贴执行。";
    } else {
      const selected = selectCommand(command);
      button.textContent = selected ? "已选中" : originalLabel;
      if (feedback) feedback.textContent = selected
        ? "已选中命令。电脑按 Ctrl+C / ⌘C，手机长按复制。"
        : "请直接选中命令，使用系统复制功能。";
    }
    button.disabled = false;
    resetTimer = setTimeout(() => { button.textContent = originalLabel; }, 3500);
  });
}
