(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  const form = $('join');
  const status = $('invite-status');
  const name = $('name');
  const key = $('recovery-key');

  async function initialize() {
    if (!code) {
      status.textContent = 'Open the complete link your collaborator sent you.';
      return;
    }
    try {
      const response = await fetch('/api/me');
      if (response.ok) {
        const me = await response.json();
        $('name-field').hidden = true;
        status.textContent = `You are signed in as ${me.name}.`;
      }
      name.required = !$('name-field').hidden;
      form.hidden = false;
    } catch {
      status.textContent = 'The workspace is unreachable. Reopen the link when you are back online.';
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      const response = await fetch('/api/invitations/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: name.value })
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Unable to accept this invitation.');
      history.replaceState(null, '', location.pathname);
      const workspace = $('workspace-link');
      workspace.href = `/?project=${encodeURIComponent(result.project_id)}`;
      workspace.textContent = 'Open the project';
      form.hidden = true;
      status.textContent = 'You joined the project.';
      if (result.recovery_key) {
        key.value = result.recovery_key;
        $('recovery').hidden = false;
        key.focus();
      } else {
        workspace.focus();
      }
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  });

  $('copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(key.value);
      status.textContent = 'Sign-in key copied.';
    } catch {
      key.select();
    }
  });

  initialize();
})();
