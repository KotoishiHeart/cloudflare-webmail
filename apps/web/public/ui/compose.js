const dialog = document.querySelector('#compose-dialog');
const form = document.querySelector('#compose-form');
const submit = document.querySelector('#compose-submit');
let requestId = '';
let submitHandler;

export function bindCompose(onSubmit) {
  submitHandler = onSubmit;
  document.querySelector('#compose-close').addEventListener('click', closeCompose);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCompose();
  });
  form.addEventListener('submit', submitCompose);
}

export function openCompose(mailbox) {
  if (!mailbox || mailbox.role === 'viewer') return;
  requestId = crypto.randomUUID();
  form.reset();
  document.querySelector('#compose-from').textContent = `差出人: ${mailbox.address}`;
  dialog.showModal();
  document.querySelector('#compose-to').focus();
}

export function closeCompose() {
  if (dialog.open) dialog.close();
  requestId = '';
}

async function submitCompose(event) {
  event.preventDefault();
  if (!submitHandler || !requestId) return;
  submit.disabled = true;
  try {
    await submitHandler({
      requestId,
      to: addresses('#compose-to'),
      cc: addresses('#compose-cc'),
      bcc: addresses('#compose-bcc'),
      subject: document.querySelector('#compose-subject').value,
      text: document.querySelector('#compose-text').value,
    });
    closeCompose();
  } catch {
    // The app-level handler keeps the draft open and displays the API error.
  } finally {
    submit.disabled = false;
  }
}

function addresses(selector) {
  return document.querySelector(selector).value
    .split(/[,;\n]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}
