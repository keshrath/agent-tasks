/* global document, window */
// An MCP Apps host for the widget e2e, on the official ext-apps AppBridge: mounts the
// built widget in a sandboxed iframe, runs the scenario's tool through the real MCP
// server (window.__callTool, exposed by widget.pw.ts) and answers the widget's calls.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const { tool, args, theme } = window.__scenario;
document.documentElement.dataset.theme = theme;
window.__calls = [];

const frame = document.createElement('iframe');
frame.setAttribute('sandbox', 'allow-scripts allow-forms');
frame.title = 'agent-tasks widget';
document.getElementById('host').append(frame);

const bridge = new AppBridge(
  null,
  { name: 'e2e-host', version: '0.0.0' },
  { openLinks: {}, serverTools: {}, updateModelContext: { text: {} }, logging: {} },
  {
    hostContext: {
      theme,
      displayMode: 'inline',
      platform: 'web',
      toolInfo: { tool: { name: tool, inputSchema: { type: 'object' } } },
    },
  },
);
bridge.oncalltool = async ({ name, arguments: a = {} }) => {
  window.__calls.push({ name, arguments: a });
  return window.__callTool(name, a);
};
bridge.onsizechange = ({ height }) => {
  if (height) frame.style.height = `${Math.ceil(height)}px`;
};
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: args });
  await bridge.sendToolResult(await window.__callTool(tool, args));
  document.body.dataset.ready = '1';
};
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.srcdoc = window.WIDGET_HTML;
