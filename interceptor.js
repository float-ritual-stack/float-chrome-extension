// interceptor.js — runs in MAIN world (page context)
// Two strategies:
// 1. Intercept fetch for conversation data (catches SPA navigation)
// 2. Provide a page-context function for on-demand API calls

(function () {
  const INTERCEPT_PATTERNS = [
    /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+(\?|$)/,
  ];

  // Strategy 1: Fetch intercept for SPA navigation
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    if (!INTERCEPT_PATTERNS.some((p) => p.test(url))) {
      return response;
    }

    try {
      const cloned = response.clone();
      const contentType = cloned.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        const data = await cloned.json();
        if (data.chat_messages) {
          postCapture(url, data);
        }
      }
    } catch (err) {
      console.error("[float-export] intercept error:", err);
    }

    return response;
  };

  // Strategy 2: On-demand fetch (handles SSR-loaded conversations)
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "FLOAT_EXPORT_FETCH_REQUEST") return;

    const { conversationId } = event.data;
    try {
      // Extract org ID from page URL or API calls
      const orgId = extractOrgId();
      if (!orgId) {
        window.postMessage(
          { type: "FLOAT_EXPORT_FETCH_ERROR", error: "Could not determine org ID" },
          "*"
        );
        return;
      }

      const url = `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;
      const resp = await originalFetch(url);

      if (!resp.ok) {
        window.postMessage(
          { type: "FLOAT_EXPORT_FETCH_ERROR", error: `API returned ${resp.status}` },
          "*"
        );
        return;
      }

      const data = await resp.json();

      // Fetch images and convert to base64 data URIs
      await embedFiles(data, orgId);

      postCapture(url, data);
    } catch (err) {
      window.postMessage(
        { type: "FLOAT_EXPORT_FETCH_ERROR", error: err.message },
        "*"
      );
    }
  });

  async function embedFiles(data, orgId) {
    const messages = data.chat_messages || [];
    let imageCount = 0;
    let textCount = 0;

    for (const msg of messages) {
      const files = msg.files_v2 || msg.files || [];
      if (!files.length) continue;

      for (const file of files) {
        const uuid = file.file_uuid || file.uuid;
        if (!uuid) continue;

        try {
          if (file.file_kind === "image") {
            // Fetch image preview as base64
            const previewUrl = file.preview_url || `/api/${orgId}/files/${uuid}/preview`;
            const imgResp = await originalFetch(previewUrl);
            if (imgResp.ok) {
              const blob = await imgResp.blob();
              const base64 = await blobToBase64(blob);
              file._embedded_base64 = base64;
              file._embedded_media_type = blob.type || "image/png";
              imageCount++;
            }
          } else if (file.file_kind === "text" || file.file_kind === "document") {
            // Fetch text content (PDFs, code files, etc.)
            const previewUrl = file.preview_url || `/api/${orgId}/files/${uuid}/preview`;
            const textResp = await originalFetch(previewUrl);
            if (textResp.ok) {
              const contentType = textResp.headers.get("content-type") || "";
              if (contentType.includes("text") || contentType.includes("json")) {
                file._embedded_text = await textResp.text();
              } else {
                // Binary doc (PDF etc) — base64
                const blob = await textResp.blob();
                file._embedded_base64 = await blobToBase64(blob);
                file._embedded_media_type = blob.type;
              }
              textCount++;
            }
          }
        } catch (err) {
          console.warn(`[float-export] failed to embed file ${file.file_name}:`, err.message);
        }
      }
    }

    if (imageCount || textCount) {
      console.log(`[float-export] embedded ${imageCount} images, ${textCount} text files`);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        // Strip the data:...;base64, prefix — we'll reconstruct it
        const result = reader.result;
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function extractOrgId() {
    // Try cookie first
    const match = document.cookie.match(/lastActiveOrg=([0-9a-f-]+)/);
    if (match) return match[1];

    // Try extracting from any existing API call in performance entries
    const entries = performance.getEntriesByType("resource");
    for (const entry of entries) {
      const m = entry.name.match(/\/api\/organizations\/([0-9a-f-]+)\//);
      if (m) return m[1];
    }

    // Try meta tag or global state
    try {
      const el = document.querySelector('meta[name="org-id"]');
      if (el) return el.content;
    } catch {}

    return null;
  }

  function postCapture(url, data) {
    const convMatch = url.match(/chat_conversations\/([0-9a-f-]+)/);
    const conversationId = convMatch ? convMatch[1] : data.uuid || "unknown";

    const messageCount = data.chat_messages?.length || "?";

    console.log(
      `[float-export] captured ${messageCount} messages from ${conversationId}`
    );

    window.postMessage(
      {
        type: "FLOAT_EXPORT_CAPTURED",
        conversationId,
        name: data.name || "",
        url,
        data,
      },
      "*"
    );
  }

  console.log("[float-export] interceptor loaded");
})();
