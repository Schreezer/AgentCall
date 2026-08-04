import { URGENT_CALLER_RELEASE } from "./generated/urgent-caller-release.js";

const MANIFEST_ETAG = `"sig-${URGENT_CALLER_RELEASE.signature.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}"`;

export function skillManifestResponse(request) {
  if (request.headers.get("if-none-match") === MANIFEST_ETAG) {
    return new Response(null, { status: 304, headers: manifestHeaders() });
  }
  return new Response(JSON.stringify({
    manifest: URGENT_CALLER_RELEASE.manifest,
    signature: URGENT_CALLER_RELEASE.signature,
  }), { status: 200, headers: manifestHeaders() });
}

export function skillBootstrapResponse() {
  return new Response(URGENT_CALLER_RELEASE.bootstrap, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(new TextEncoder().encode(URGENT_CALLER_RELEASE.bootstrap).byteLength),
      "content-type": "text/x-python; charset=utf-8",
      etag: `"sha256-${URGENT_CALLER_RELEASE.bootstrapSha256}"`,
      "x-content-type-options": "nosniff",
      "x-caller-content-sha256": URGENT_CALLER_RELEASE.bootstrapSha256,
    },
  });
}

export function skillFileResponse(version, encodedPath) {
  if (version !== URGENT_CALLER_RELEASE.manifest.skill_version) {
    return jsonError(404, "skill_release_not_found");
  }
  let path;
  try {
    path = encodedPath.split("/").map((part) => decodeURIComponent(part)).join("/");
  } catch {
    return jsonError(400, "invalid_skill_release_path");
  }
  if (!Object.hasOwn(URGENT_CALLER_RELEASE.files, path)) {
    return jsonError(404, "skill_release_file_not_found");
  }
  const contentType = path.endsWith(".json")
    ? "application/json; charset=utf-8"
    : path.endsWith(".py")
      ? "text/x-python; charset=utf-8"
      : "text/markdown; charset=utf-8";
  return skillContentResponse(path, contentType, true);
}

export function withSkillReleaseHeaders(response, request) {
  const wrapped = new Response(response.body, response);
  const installed = request.headers.get("x-caller-skill-version");
  const latest = URGENT_CALLER_RELEASE.manifest.skill_version;
  const minimum = URGENT_CALLER_RELEASE.manifest.minimum_supported_version;
  wrapped.headers.set("x-caller-skill-latest", latest);
  wrapped.headers.set("x-caller-skill-minimum", minimum);
  wrapped.headers.set("x-caller-skill-update", updateStatus(installed, latest, minimum));
  return wrapped;
}

export function releaseMetadata() {
  return URGENT_CALLER_RELEASE;
}

function skillContentResponse(path, contentType, immutable) {
  const content = URGENT_CALLER_RELEASE.files[path];
  const entry = URGENT_CALLER_RELEASE.manifest.files.find((item) => item.path === path);
  return new Response(content, {
    status: 200,
    headers: {
      "cache-control": immutable ? "private, max-age=31536000, immutable" : "no-store",
      "content-length": String(entry.size),
      "content-type": contentType,
      etag: `"sha256-${entry.sha256}"`,
      "x-content-type-options": "nosniff",
      "x-caller-content-sha256": entry.sha256,
    },
  });
}

function manifestHeaders() {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    etag: MANIFEST_ETAG,
    "x-content-type-options": "nosniff",
  };
}

function updateStatus(installed, latest, minimum) {
  if (!installed || !validVersion(installed)) return "unknown";
  if (compareVersions(installed, minimum) < 0) return "required";
  if (compareVersions(installed, latest) < 0) return "available";
  return "current";
}

function validVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}
