// content_script.js — runs in ISOLATED world
// Bridges between page context (interceptor) and extension background

// Forward captures from interceptor to background
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "FLOAT_EXPORT_CAPTURED") {
    chrome.runtime.sendMessage({
      type: "CONVERSATION_CAPTURED",
      conversationId: event.data.conversationId,
      name: event.data.name,
      url: event.data.url,
      data: event.data.data,
      capturedAt: new Date().toISOString(),
    });
  }

  if (event.data?.type === "FLOAT_EXPORT_FETCH_ERROR") {
    chrome.runtime.sendMessage({
      type: "FETCH_ERROR",
      error: event.data.error,
    });
  }
});

// Listen for export trigger from popup/background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRIGGER_FETCH") {
    // Ask the MAIN world interceptor to fetch conversation data
    window.postMessage(
      {
        type: "FLOAT_EXPORT_FETCH_REQUEST",
        conversationId: message.conversationId,
      },
      "*"
    );
    sendResponse({ ok: true });
  }

  if (message.type === "GET_PAGE_INFO") {
    const urlMatch = window.location.pathname.match(/\/chat\/([0-9a-f-]+)/);
    sendResponse({
      conversationId: urlMatch ? urlMatch[1] : null,
      title: document.title?.replace(/ - Claude$/, "").trim() || "",
      pageUrl: window.location.href,
      onClaudeDotAi: window.location.hostname === "claude.ai",
    });
  }
});

// Auto-capture: extract page info on load and URL changes
function notifyPageInfo() {
  const urlMatch = window.location.pathname.match(/\/chat\/([0-9a-f-]+)/);
  if (urlMatch) {
    chrome.runtime.sendMessage({
      type: "PAGE_META",
      conversationId: urlMatch[1],
      title: document.title?.replace(/ - Claude$/, "").trim() || "",
      pageUrl: window.location.href,
    });
  }
}

// Run after DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", notifyPageInfo);
} else {
  setTimeout(notifyPageInfo, 500);
}

// SPA navigation detection
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(notifyPageInfo, 500);
  }
}).observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
});

console.log("[float-export] content script loaded");
