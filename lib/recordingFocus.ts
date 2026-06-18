/** 录制时 CSS 伪全屏：隐藏页面其余 UI，只保留预览区 */

export type RecordingFocusState = {
  style: string;
  attr: string | null;
};

export function applyRecordingFocus(
  target: HTMLElement | null,
  focusStateRef: { current: RecordingFocusState | null },
) {
  if (!target || focusStateRef.current) return;
  focusStateRef.current = {
    style: target.getAttribute("style") || "",
    attr: target.getAttribute("data-recording-target"),
  };
  target.setAttribute("data-recording-target", "true");
  target.style.position = "fixed";
  target.style.top = "0";
  target.style.left = "0";
  target.style.bottom = "0";
  target.style.right = "0";
  target.style.width = "100vw";
  target.style.height = "100vh";
  target.style.maxWidth = "none";
  target.style.maxHeight = "none";
  target.style.borderRadius = "0";
  target.style.boxShadow = "none";
  target.style.border = "none";
  target.style.margin = "0";
  target.style.padding = "0";
  target.style.zIndex = "2147483646";
  document.body.classList.add("recording-mode");
  if (!document.getElementById("recording-mode-style")) {
    const style = document.createElement("style");
    style.id = "recording-mode-style";
    style.textContent = [
      "body.recording-mode * { visibility: hidden !important; }",
      'body.recording-mode [data-recording-target="true"],',
      'body.recording-mode [data-recording-target="true"] * { visibility: visible !important; }',
      "body.recording-mode { background: #000 !important; }",
      'body.recording-mode [data-recording-target="true"] .preview-stage { border-radius: 0 !important; box-shadow: none !important; }',
    ].join("\n");
    document.head.appendChild(style);
  }
}

export function clearRecordingFocus(
  target: HTMLElement | null,
  focusStateRef: { current: RecordingFocusState | null },
) {
  const state = focusStateRef.current;
  if (state && target) {
    target.setAttribute("style", state.style);
    if (state.attr === null) {
      target.removeAttribute("data-recording-target");
    } else {
      target.setAttribute("data-recording-target", state.attr);
    }
    focusStateRef.current = null;
  }
  document.body.classList.remove("recording-mode");
  document.getElementById("recording-mode-style")?.remove();
}
