const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function load() {
  const cfg = await chrome.storage.sync.get([
    "langfuseHost",
    "publicKey",
    "secretKey",
  ]);
  if (cfg.langfuseHost) $("host").value = cfg.langfuseHost;
  if (cfg.publicKey) $("pk").value = cfg.publicKey;
  if (cfg.secretKey) $("sk").value = cfg.secretKey;
  if (cfg.publicKey && cfg.secretKey && cfg.langfuseHost) {
    setStatus("Verificando…", "wait");
    verify();
  }
}

function verify() {
  chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus("Error: background no disponible", "err");
      return;
    }
    if (res?.ok) {
      setStatus(`Conectado — Langfuse ${res.version ?? ""}`, "ok");
    } else {
      setStatus(`Error: ${res?.error ?? "desconocido"}`, "err");
    }
  });
}

$("save").addEventListener("click", async () => {
  const host = $("host").value.trim();
  const pk = $("pk").value.trim();
  const sk = $("sk").value.trim();

  if (!host || !pk || !sk) {
    setStatus("Completa todos los campos", "err");
    return;
  }

  await chrome.storage.sync.set({
    langfuseHost: host,
    publicKey: pk,
    secretKey: sk,
  });
  setStatus("Guardado. Verificando…", "wait");
  verify();
});

load();
