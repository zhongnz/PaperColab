(() => {
  'use strict';

  const views = new WeakMap();
  const inviteRoles = ['reader', 'reviewer', 'author'];

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function button(text, action) {
    const node = element('button', text);
    node.type = 'button';
    node.className = 'secondary';
    node.addEventListener('click', action);
    return node;
  }

  function roleChoice(roles, current, label) {
    const select = element('select');
    select.setAttribute('aria-label', label);
    select.replaceChildren(...roles.map(role => new Option(role[0].toUpperCase() + role.slice(1), role)));
    select.value = current;
    return select;
  }

  function render(container, project, me, api, refresh) {
    if (!container) return;
    const lead = me?.kind === 'human' && project.members.some(member => member.id === me.id && member.role === 'lead');
    if (!lead) {
      views.delete(container);
      container.replaceChildren();
      return;
    }
    const signature = JSON.stringify([project.id, me.id, project.members]);
    if (views.get(container)?.signature === signature) return;
    const existing = views.get(container);
    const open = Boolean(existing?.project === project.id && existing.details.open);
    const details = element('details');
    details.append(element('summary', 'Manage access'));
    details.open = open;
    const status = element('p');
    status.className = 'muted';
    status.setAttribute('role', 'status');
    const endpoint = `/api/projects/${project.id}`;

    async function perform(work, control) {
      if (control) control.disabled = true;
      status.textContent = '';
      try {
        await work();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        if (control) control.disabled = false;
      }
    }

    const inviteRole = roleChoice(inviteRoles, 'author', 'Invitation role');
    const inviteTools = element('div');
    inviteTools.className = 'project-tools';
    const link = element('input');
    link.type = 'text';
    link.readOnly = true;
    link.setAttribute('aria-label', 'Invitation link');
    const linkTools = element('div');
    linkTools.className = 'project-tools';
    linkTools.hidden = true;
    const copy = button('Copy invitation', () => perform(async () => {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(link.value);
        status.textContent = 'Invitation copied.';
      } else {
        link.select();
      }
    }));
    linkTools.append(link, copy);
    const activeInvites = element('div');

    async function listInvitations() {
      const invites = await api('GET', `${endpoint}/invitations`);
      activeInvites.replaceChildren();
      for (const invite of invites) {
        const row = element('div');
        row.className = 'project-tools';
        const expiry = new Date(invite.expires_at * 1000).toLocaleDateString();
        const cancel = button('Revoke invitation', () => perform(async () => {
          await api('DELETE', `${endpoint}/invitations/${invite.id}`);
          if (link.dataset.invitation === invite.id) linkTools.hidden = true;
          await listInvitations();
        }, cancel));
        row.append(element('span', `${invite.role} invitation · expires ${expiry}`), cancel);
        activeInvites.append(row);
      }
    }

    const invite = button('Create invitation', () => perform(async () => {
      const result = await api('POST', `${endpoint}/invitations`, { role: inviteRole.value });
      const url = new URL('/invite.html', location.origin);
      url.hash = new URLSearchParams({ code: result.code });
      link.value = url.href;
      link.dataset.invitation = result.id;
      linkTools.hidden = false;
      status.textContent = 'Share this single-use link with your collaborator.';
      await listInvitations();
    }, invite));
    inviteTools.append(inviteRole, invite);
    details.append(inviteTools, linkTools, status, activeInvites);

    for (const member of project.members.filter(member => member.id !== me.id)) {
      const row = element('div');
      row.className = 'project-tools';
      const choices = member.kind === 'human' ? [...inviteRoles, 'lead'] : inviteRoles;
      const role = roleChoice(choices, member.role, `Project role for ${member.name}`);
      const save = button('Save role', () => perform(async () => {
        await api('POST', `${endpoint}/members`, { actor_id: member.id, role: role.value });
        await refresh();
      }, save));
      const remove = button('Remove access', () => perform(async () => {
        if (!window.confirm(`Remove ${member.name} from this project?`)) return;
        await api('DELETE', `${endpoint}/members/${member.id}`);
        await refresh();
      }, remove));
      row.append(element('span', member.name), role, save, remove);
      details.append(row);
    }
    details.addEventListener('toggle', () => {
      if (details.open) perform(listInvitations);
    });
    views.set(container, { signature, project: project.id, details });
    container.replaceChildren(details);
  }

  globalThis.PaperColabAccess = { render };
})();
