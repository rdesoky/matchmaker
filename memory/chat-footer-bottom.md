---
name: chat-footer-bottom
description: Snap v2 chat form + status bar to bottom of page
metadata:
  type: project
---

In V2, the chat form (#ChatTypingBox) and status bar (#StatusView) live inside .chat_footer, which flows inline within #Contents. They must be snapped/fixed to the bottom of the viewport so they stay visible while scrolling the message list.

Changes (v2 only):
- v2/css/chat.scss: .chat_footer gets position:fixed; bottom:0; left:0; right:0 with --kb-surface background, --kb-border-strong top border, drop shadow, z-index. #ChatTypingBox drops its now-duplicated border/background/clear (footer provides them). #Contents gets display:flow-root (contains floats now that the fixed footer no longer clears them) and padding-bottom to reserve space so the last message isn't hidden behind the footer. chat.scss only loads on the chat page, so the #Contents rule is chat-scoped.
- Mirrors v3's approach (#ChatFooter fixed at bottom, #Contents.chat_pg padding-bottom).

Mirrored after v3 (already fixed): v3/css/chat.scss #ChatFooter, v3/modules/chat.js.

Verify: npm run build + dev server, view http://127.0.0.1:8080/v2/#pg=chat in light and dark mode; run npm test.
