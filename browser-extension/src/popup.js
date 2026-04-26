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

function needsOptionalPermission(hostUrl) {
  try {
    const u = new URL(hostUrl);
    return u.hostname !== "localhost" && u.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

$("save").addEventListener("click", async () => {
  const host = $("host").value.trim();
  const pk = $("pk").value.trim();
  const sk = $("sk").value.trim();

  if (!host || !pk || !sk) {
    setStatus("Completa todos los campos", "err");
    return;
  }

  // Request host permission for remote Langfuse instances.
  // localhost/127.0.0.1 are already in host_permissions; remotes need this.
  if (needsOptionalPermission(host)) {
    const origin = new URL(host).origin + "/*";
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      setStatus(
        "Permiso de red denegado — el host Langfuse no será accesible",
        "err",
      );
      return;
    }
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
