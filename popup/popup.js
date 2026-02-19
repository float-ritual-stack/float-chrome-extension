import { formatConversation, formatForOutliner, formatBundle } from "../lib/formatter.js";

const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const metaTitle = document.getElementById("metaTitle");
const metaMessages = document.getElementById("metaMessages");
const metaTime = document.getElementById("metaTime");
const copyBtn = document.getElementById("copyBtn");
const outlinerBtn = document.getElementById("outlinerBtn");
const bundleBtn = document.getElementById("bundleBtn");
const downloadBtn = document.getElementById("downloadBtn");
const toast = document.getElementById("toast");

let pageInfo = null;

async function init() {
  // Get current tab's page info
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusEl.textContent = "No active tab";
    return;
  }

  try {
    pageInfo = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_INFO" });
  } catch {
    statusEl.textContent = "Not on claude.ai";
    return;
  }

  if (!pageInfo?.onClaudeDotAi || !pageInfo?.conversationId) {
    statusEl.textContent = "Navigate to a Claude conversation first";
    return;
  }

  // Check if we already have captured data
  const status = await chrome.runtime.sendMessage({
    type: "GET_STATUS",
    conversationId: pageInfo.conversationId,
  });

  if (status?.captured) {
    showCaptured(status);
  } else {
    statusEl.textContent = "Ready to export";
    statusEl.className = "status ready";
    copyBtn.disabled = false;
    outlinerBtn.disabled = false;
    bundleBtn.disabled = false;
    copyBtn.textContent = "Fetch & Copy";
    downloadBtn.style.display = "block";
    downloadBtn.textContent = "Fetch & Download .md";

    metaEl.style.display = "block";
    metaTitle.textContent = pageInfo.title || pageInfo.conversationId;
  }
}

function showCaptured(status) {
  statusEl.textContent = "Conversation captured";
  statusEl.className = "status captured";
  copyBtn.disabled = false;
  outlinerBtn.disabled = false;
  bundleBtn.disabled = false;
  copyBtn.textContent = "Copy to Clipboard";
  downloadBtn.style.display = "block";
  downloadBtn.textContent = "Download .md";

  metaEl.style.display = "block";
  metaTitle.textContent = status.name || pageInfo?.conversationId || "";
  metaMessages.textContent = `Messages: ${status.messageCount}`;
  if (status.capturedAt) {
    metaTime.textContent = `Captured: ${formatTime(status.capturedAt)}`;
  }
}

async function ensureCapture() {
  // Check if already captured
  let status = await chrome.runtime.sendMessage({
    type: "GET_STATUS",
    conversationId: pageInfo.conversationId,
  });

  if (status?.captured) return true;

  // Trigger fetch — large conversations can take 15-30s
  statusEl.textContent = "Fetching + embedding images (may take 60s)...";
  statusEl.className = "status ready";
  const result = await chrome.runtime.sendMessage({
    type: "TRIGGER_EXPORT",
    conversationId: pageInfo.conversationId,
  });

  if (result?.ok) {
    showCaptured(result);
    return true;
  } else {
    showToast("Fetch failed: " + (result?.error || "unknown"), true);
    return false;
  }
}

copyBtn.addEventListener("click", async () => {
  if (!pageInfo?.conversationId) return;

  try {
    copyBtn.disabled = true;
    copyBtn.textContent = "Exporting...";

    const captured = await ensureCapture();
    if (!captured) {
      copyBtn.disabled = false;
      copyBtn.textContent = "Retry";
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: "GET_CAPTURE_DATA",
      conversationId: pageInfo.conversationId,
    });

    if (!result?.ok) {
      showToast("Export failed: " + (result?.error || "unknown"), true);
      return;
    }

    const markdown = formatConversation(result.data, {
      conversationId: result.conversationId,
      name: result.name,
    });

    await navigator.clipboard.writeText(markdown);
    showToast(`Copied! (${markdown.length.toLocaleString()} chars)`);
  } catch (err) {
    showToast("Copy failed: " + err.message, true);
  } finally {
    copyBtn.disabled = false;
    copyBtn.textContent = "Copy to Clipboard";
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!pageInfo?.conversationId) return;

  try {
    downloadBtn.disabled = true;

    const captured = await ensureCapture();
    if (!captured) {
      downloadBtn.disabled = false;
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: "GET_CAPTURE_DATA",
      conversationId: pageInfo.conversationId,
    });

    if (!result?.ok) {
      showToast("Export failed: " + (result?.error || "unknown"), true);
      return;
    }

    const markdown = formatConversation(result.data, {
      conversationId: result.conversationId,
      name: result.name,
    });

    const slug = (result.name || pageInfo.conversationId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
    const filename = `claude-${slug}-${dateStamp()}.md`;

    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showToast("Downloaded " + filename);
  } catch (err) {
    showToast("Download failed: " + err.message, true);
  } finally {
    downloadBtn.disabled = false;
  }
});

outlinerBtn.addEventListener("click", async () => {
  if (!pageInfo?.conversationId) return;

  try {
    outlinerBtn.disabled = true;
    outlinerBtn.textContent = "Exporting...";

    const captured = await ensureCapture();
    if (!captured) {
      outlinerBtn.disabled = false;
    bundleBtn.disabled = false;
      outlinerBtn.textContent = "Export for Outliner";
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: "GET_CAPTURE_DATA",
      conversationId: pageInfo.conversationId,
    });

    if (!result?.ok) {
      showToast("Export failed: " + (result?.error || "unknown"), true);
      return;
    }

    const outlinerText = formatForOutliner(result.data, {
      conversationId: result.conversationId,
      name: result.name,
    });

    const slug = (result.name || pageInfo.conversationId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
    const filename = `outliner-${slug}-${dateStamp()}.md`;

    const blob = new Blob([outlinerText], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showToast("Outliner export: " + filename);
  } catch (err) {
    showToast("Export failed: " + err.message, true);
  } finally {
    outlinerBtn.disabled = false;
    bundleBtn.disabled = false;
    outlinerBtn.textContent = "Export for Outliner";
  }
});

bundleBtn.addEventListener("click", async () => {
  if (!pageInfo?.conversationId) return;

  try {
    bundleBtn.disabled = true;
    bundleBtn.textContent = "Building bundle...";

    const captured = await ensureCapture();
    if (!captured) {
      bundleBtn.disabled = false;
      bundleBtn.textContent = "Download Bundle (.zip)";
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: "GET_CAPTURE_DATA",
      conversationId: pageInfo.conversationId,
    });

    if (!result?.ok) {
      showToast("Export failed: " + (result?.error || "unknown"), true);
      return;
    }

    const bundle = formatBundle(result.data, {
      conversationId: result.conversationId,
      name: result.name,
    });

    // Load JSZip dynamically
    const JSZip = await loadJSZip();
    const zip = new JSZip();

    // Add markdown
    zip.file("conversation.md", bundle.markdown);

    // Add extracted files
    for (const file of bundle.files) {
      if (file.type === "base64") {
        zip.file(file.path, file.data, { base64: true });
      } else {
        zip.file(file.path, file.data);
      }
    }

    // Generate and download
    const blob = await zip.generateAsync({ type: "blob" });
    const slug = (result.name || pageInfo.conversationId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
    const filename = `claude-${slug}-${dateStamp()}.zip`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    const fileCount = bundle.files.length;
    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    showToast(`Bundle: ${fileCount} files, ${sizeMB}MB`);
  } catch (err) {
    showToast("Bundle failed: " + err.message, true);
  } finally {
    bundleBtn.disabled = false;
    bundleBtn.textContent = "Download Bundle (.zip)";
  }
});

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  // Load from vendored file
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "../lib/jszip.min.js";
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => reject(new Error("Failed to load JSZip"));
    document.head.appendChild(script);
  });
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.className = `toast visible${isError ? " error" : ""}`;
  setTimeout(() => {
    toast.className = "toast";
  }, 3000);
}

init();
