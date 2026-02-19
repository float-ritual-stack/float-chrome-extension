// background.js — service worker
// Stores captured conversation data, handles export orchestration

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "CONVERSATION_CAPTURED":
      handleCapture(message, sender?.tab?.id);
      sendResponse({ ok: true });
      break;

    case "PAGE_META":
      handlePageMeta(message);
      sendResponse({ ok: true });
      break;

    case "FETCH_ERROR":
      console.error("[float-export] fetch error:", message.error);
      sendResponse({ ok: false, error: message.error });
      break;

    case "GET_STATUS":
      getStatus(message.conversationId).then(sendResponse);
      return true; // async

    case "TRIGGER_EXPORT":
      triggerExport(message.conversationId, message.tabId).then(sendResponse);
      return true; // async

    case "GET_CAPTURE_DATA":
      getCaptureData(message.conversationId).then(sendResponse);
      return true; // async

    default:
      sendResponse({ ok: false, error: "unknown message type" });
  }
});

async function handleCapture(message, tabId) {
  const key = `conv_${message.conversationId}`;
  await chrome.storage.local.set({
    [key]: {
      data: message.data,
      name: message.name,
      url: message.url,
      capturedAt: message.capturedAt,
      conversationId: message.conversationId,
    },
  });

  // Track which conversation is current for this tab
  if (tabId) {
    await chrome.storage.local.set({
      [`tab_${tabId}`]: message.conversationId,
    });
  }

  // Badge
  chrome.action.setBadgeText({ text: "OK" });
  chrome.action.setBadgeBackgroundColor({ color: "#10b981" });

  console.log(
    `[float-export] stored ${message.data?.chat_messages?.length || "?"} messages for ${message.conversationId}`
  );

  // Evict old captures — keep last 5
  await evictOldCaptures(5);
}

async function evictOldCaptures(keepCount) {
  const all = await chrome.storage.local.get(null);
  const captures = Object.entries(all)
    .filter(([k]) => k.startsWith("conv_"))
    .map(([k, v]) => ({ key: k, capturedAt: v.capturedAt || "" }))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

  if (captures.length <= keepCount) return;

  const toRemove = captures.slice(keepCount).map((c) => c.key);
  // Also remove matching meta keys
  const metaKeys = toRemove.map((k) => k.replace("conv_", "meta_"));
  await chrome.storage.local.remove([...toRemove, ...metaKeys]);

  console.log(`[float-export] evicted ${toRemove.length} old captures`);
}

async function handlePageMeta(message) {
  const key = `meta_${message.conversationId}`;
  await chrome.storage.local.set({
    [key]: {
      title: message.title,
      pageUrl: message.pageUrl,
      conversationId: message.conversationId,
    },
  });
}

async function getStatus(conversationId) {
  if (!conversationId) return { captured: false };

  const convKey = `conv_${conversationId}`;
  const metaKey = `meta_${conversationId}`;
  const result = await chrome.storage.local.get([convKey, metaKey]);

  const capture = result[convKey];
  const meta = result[metaKey];

  return {
    captured: !!capture,
    conversationId,
    name: capture?.name || meta?.title || "",
    messageCount: capture?.data?.chat_messages?.length || 0,
    capturedAt: capture?.capturedAt || null,
  };
}

async function triggerExport(conversationId, tabId) {
  // Send message to content script to trigger fetch via interceptor
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return { ok: false, error: "No active tab" };

    await chrome.tabs.sendMessage(tab.id, {
      type: "TRIGGER_FETCH",
      conversationId,
    });

    // Wait for the fetch to complete and data to arrive
    // Large conversations (100+ messages with tool calls) can take 15-30s
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 240; // 60 seconds total (image-heavy convos need time)
      const check = async () => {
        attempts++;
        const status = await getStatus(conversationId);
        if (status.captured) {
          resolve({ ok: true, ...status });
        } else if (attempts > maxAttempts) {
          resolve({ ok: false, error: "Timeout waiting for data (30s)" });
        } else {
          setTimeout(check, 250);
        }
      };
      setTimeout(check, 500);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getCaptureData(conversationId) {
  const convKey = `conv_${conversationId}`;
  const metaKey = `meta_${conversationId}`;
  const result = await chrome.storage.local.get([convKey, metaKey]);

  const capture = result[convKey];
  const meta = result[metaKey];

  if (!capture) return { ok: false, error: "No capture found" };

  return {
    ok: true,
    data: capture.data,
    name: capture.name || meta?.title || "",
    conversationId,
  };
}
