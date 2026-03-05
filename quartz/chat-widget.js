(function() {
  // Configure chat API endpoint — each node points to its own chat backend
  var CHAT_API = window.__BKC_CHAT_API || "/api/chat";

  // Persist state across SPA navigations
  if (!window.__octoChat) {
    window.__octoChat = { sessionId: null, messages: [], initialized: false };
  }
  var state = window.__octoChat;

  function createWidget() {
    // Already exists in DOM — skip
    if (document.getElementById("octo-chat-toggle")) return;

    var style = document.createElement("style");
    style.id = "octo-chat-style";
    if (!document.getElementById("octo-chat-style")) {
      style.textContent = "\
        #octo-chat-toggle {\
          position: fixed; bottom: 24px; right: 24px; z-index: 9999;\
          width: 56px; height: 56px; border-radius: 50%;\
          background: var(--secondary, #1e6b4e); color: white;\
          border: none; cursor: pointer; font-size: 28px;\
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);\
          transition: transform 0.2s, background 0.2s;\
          display: flex; align-items: center; justify-content: center;\
        }\
        #octo-chat-toggle:hover { transform: scale(1.1); }\
        #octo-chat-panel {\
          position: fixed; bottom: 92px; right: 24px; z-index: 9998;\
          width: 380px; max-width: calc(100vw - 48px);\
          height: 500px; max-height: calc(100vh - 120px);\
          background: var(--light, #f8faf9); border: 1px solid var(--lightgray, #dde8e3);\
          border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.2);\
          display: none; flex-direction: column; overflow: hidden;\
          font-family: var(--bodyFont, 'Source Sans Pro', sans-serif);\
        }\
        #octo-chat-panel.open { display: flex; }\
        #octo-chat-header {\
          padding: 14px 16px; background: var(--secondary, #1e6b4e); color: white;\
          font-weight: 600; font-size: 15px; display: flex; align-items: center;\
          justify-content: space-between; flex-shrink: 0;\
        }\
        #octo-chat-header-left { display: flex; align-items: center; gap: 8px; }\
        #octo-chat-header-left span { font-size: 20px; }\
        #octo-chat-close {\
          background: none; border: none; color: white; font-size: 20px;\
          cursor: pointer; padding: 0 4px; opacity: 0.8;\
        }\
        #octo-chat-close:hover { opacity: 1; }\
        #octo-chat-messages {\
          flex: 1; overflow-y: auto; padding: 12px 16px;\
          display: flex; flex-direction: column; gap: 10px;\
        }\
        .octo-msg {\
          max-width: 85%; padding: 10px 14px; border-radius: 12px;\
          font-size: 14px; line-height: 1.5; word-wrap: break-word;\
        }\
        .octo-msg a { color: var(--secondary, #1e6b4e); }\
        .octo-msg.bot {\
          align-self: flex-start; background: var(--lightgray, #dde8e3);\
          color: var(--darkgray, #3a4f45); border-bottom-left-radius: 4px;\
        }\
        .octo-msg.user {\
          align-self: flex-end; background: var(--secondary, #1e6b4e);\
          color: white; border-bottom-right-radius: 4px;\
        }\
        .octo-msg.typing { opacity: 0.7; font-style: italic; }\
        #octo-chat-input-area {\
          padding: 12px; border-top: 1px solid var(--lightgray, #dde8e3);\
          display: flex; gap: 8px; flex-shrink: 0;\
        }\
        #octo-chat-input {\
          flex: 1; padding: 10px 12px; border: 1px solid var(--lightgray, #dde8e3);\
          border-radius: 8px; font-size: 14px; outline: none;\
          background: var(--light, #f8faf9); color: var(--darkgray, #3a4f45);\
          font-family: var(--bodyFont, 'Source Sans Pro', sans-serif);\
        }\
        #octo-chat-input:focus { border-color: var(--secondary, #1e6b4e); }\
        #octo-chat-send {\
          padding: 10px 16px; background: var(--secondary, #1e6b4e); color: white;\
          border: none; border-radius: 8px; cursor: pointer; font-size: 14px;\
          font-weight: 600;\
        }\
        #octo-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }\
      ";
      document.head.appendChild(style);
    }

    // Toggle button
    var toggle = document.createElement("button");
    toggle.id = "octo-chat-toggle";
    toggle.innerHTML = "\uD83D\uDCAC";
    toggle.title = "Chat with this knowledge node";
    toggle.onclick = function() {
      var panel = document.getElementById("octo-chat-panel");
      var isOpen = panel.classList.contains("open");
      panel.classList.toggle("open", !isOpen);
      if (!isOpen) document.getElementById("octo-chat-input").focus();
    };
    document.body.appendChild(toggle);

    // Chat panel
    var panel = document.createElement("div");
    panel.id = "octo-chat-panel";
    panel.innerHTML = '<div id="octo-chat-header"><div id="octo-chat-header-left"><span>\uD83D\uDCAC</span> Ask</div><button id="octo-chat-close">\u00D7</button></div><div id="octo-chat-messages"></div><div id="octo-chat-input-area"><input id="octo-chat-input" placeholder="Ask about bioregional knowledge..." maxlength="500" /><button id="octo-chat-send">Send</button></div>';
    document.body.appendChild(panel);

    // Close button
    document.getElementById("octo-chat-close").onclick = function() {
      panel.classList.remove("open");
    };

    var messages = document.getElementById("octo-chat-messages");
    var input = document.getElementById("octo-chat-input");
    var sendBtn = document.getElementById("octo-chat-send");

    function addMessage(type, text, save) {
      var div = document.createElement("div");
      div.className = "octo-msg " + type;
      var html = text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\n/g, "<br>");
      div.innerHTML = html;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      if (save !== false) {
        state.messages.push({ type: type, text: text });
      }
      return div;
    }

    // Restore previous messages or show welcome
    if (state.messages.length > 0) {
      state.messages.forEach(function(m) { addMessage(m.type, m.text, false); });
    } else {
      addMessage("bot", "Hey! Ask me anything about bioregional knowledge, practices, or patterns in this knowledge garden.");
    }

    function sendMessage() {
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendBtn.disabled = true;
      input.disabled = true;

      addMessage("user", text);
      var typing = document.createElement("div");
      typing.className = "octo-msg bot typing";
      typing.textContent = "Thinking...";
      messages.appendChild(typing);
      messages.scrollTop = messages.scrollHeight;

      fetch(CHAT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: state.sessionId })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        typing.remove();
        if (data.error) {
          addMessage("bot", data.error);
        } else {
          state.sessionId = data.sessionId;
          addMessage("bot", data.reply);
        }
      })
      .catch(function() {
        typing.remove();
        addMessage("bot", "Connection error. Please try again.");
      })
      .finally(function() {
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
      });
    }

    sendBtn.onclick = sendMessage;
    input.onkeydown = function(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  }

  // Initial creation
  createWidget();

  // Re-create after Quartz SPA navigation
  document.addEventListener("nav", function() {
    createWidget();
  });
})();
