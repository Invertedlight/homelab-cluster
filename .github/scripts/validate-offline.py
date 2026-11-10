#!/usr/bin/env python3
"""Offline validation for the skynet Flux repository.

Runs kustomize, kubeconform, a SOPS plaintext-secret guard, and yamllint.
Nothing in this script reads a kubeconfig, decrypts SOPS, or calls the
cluster API. Flux postBuild.substituteFrom is rejected because resolving it
would need cluster ConfigMaps or Secrets.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

# k3s v1.36.3+k3s1. kubernetes-json-schema publishes this patch.
KUBERNETES_VERSION = "1.36.3"
# datreeio/CRDs-catalog commit that carries Flux CRDs v2.10.0, matching
# clusters/skynet/flux-system/gotk-components.yaml.
CRDS_CATALOG_SHA = "49729e49e8f062933e3716a26540d41b0cd0856c"
CRDS_CATALOG_URL = (
    "https://raw.githubusercontent.com/datreeio/CRDs-catalog/"
    + CRDS_CATALOG_SHA
    + "/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
)
SUBSTITUTE_ANNOTATION = "kustomize.toolkit.fluxcd.io/substitute"
KUSTOMIZATION_NAMES = ("kustomization.yaml", "kustomization.yml", "Kustomization")
VAR_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENC_VALUE = re.compile(r"^ENC\[")
ENC_BLOB = re.compile(r"ENC\[[^]]*]")
YAML_SUFFIXES = (".yaml", ".yml", ".yaml.example", ".yml.example")

REPO_ROOT = Path(__file__).resolve().parents[2]


def redact(text: str) -> str:
    return ENC_BLOB.sub("ENC[redacted]", text or "")


def eprint(message: str) -> None:
    print(redact(message), file=sys.stderr)


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


def is_example_secret(path: Path) -> bool:
    """Plaintext templates are ignored by filename, wherever they live.

    The Node-RED template is apps/skynet/node-red/node-red-admin-secret.example.yaml.
    The cloudflared template is
    infrastructure/controllers/base/cloudflared/tunnel-token.secret.yaml.example.
    A Kustomization that lists either file still fails.
    """
    name = path.name
    return name.endswith(
        (".example.yaml", ".example.yml", ".yaml.example", ".yml.example")
    )


def has_kustomization(directory: Path) -> bool:
    return any((directory / name).is_file() for name in KUSTOMIZATION_NAMES)


def iter_yaml_files(root: Path) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name != ".git"]
        for name in filenames:
            if name.endswith(YAML_SUFFIXES):
                found.append(Path(dirpath) / name)
    return sorted(found)


def load_documents(path: Path) -> list[object]:
    text = path.read_text(encoding="utf-8")
    docs = list(yaml.safe_load_all(text))
    return docs


def split_documents(text: str) -> list[str]:
    """Split a multi-doc YAML stream on column-0 document markers."""
    docs: list[str] = []
    buffer: list[str] = []
    for line in text.splitlines(keepends=True):
        if re.match(r"^---[ \t]*\r?\n?$", line):
            if any(part.strip() for part in buffer):
                docs.append("".join(buffer))
            buffer = []
            continue
        buffer.append(line)
    if any(part.strip() for part in buffer):
        docs.append("".join(buffer))
    return docs


def strip_top_level_sops(document: str) -> str:
    """Drop the top-level sops metadata block from one YAML document.

    Flux deletes this key when it decrypts. The Secret schema rejects it
    under kubeconform -strict, so validation sees the object the API server
    would see after decryption. Ciphertext is left in place; nothing is decrypted.
    """
    lines_out: list[str] = []
    skipping = False
    for line in document.splitlines(keepends=True):
        if not skipping:
            if line.startswith("sops:"):
                rest = line[len("sops:") :].strip()
                if rest == "" or rest.startswith("#"):
                    skipping = True
                continue
            lines_out.append(line)
            continue
        if line.strip() == "" or line[0] in " \t":
            continue
        skipping = False
        lines_out.append(line)
    return "".join(lines_out)


def prepare_for_kubeconform(text: str) -> str:
    rendered: list[str] = []
    for document in split_documents(text):
        try:
            parsed = yaml.safe_load(document)
        except yaml.YAMLError:
            rendered.append(document)
            continue
        if isinstance(parsed, dict) and "sops" in parsed:
            rendered.append(strip_top_level_sops(document))
        else:
            rendered.append(document)
    body = "\n---\n".join(part.strip("\n") for part in rendered if part.strip())
    return body + ("\n" if body else "")


def nearest_sops_policy(path: Path, repo: Path) -> Path | None:
    current = path.parent
    while True:
        candidate = current / ".sops.yaml"
        if candidate.is_file():
            return candidate
        if current == repo or current.parent == current:
            return None
        current = current.parent


def load_creation_rules(path: Path) -> list[dict]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    rules = data.get("creation_rules") or []
    if not isinstance(rules, list):
        raise ValueError(f"{path} creation_rules is not a list")
    return rules


def matching_rule(rules: list[dict], secret_path: Path, policy_path: Path, repo: Path) -> dict | None:
    candidates = [secret_path.name]
    try:
        candidates.append(secret_path.relative_to(policy_path.parent).as_posix())
    except ValueError:
        pass
    try:
        candidates.append(secret_path.relative_to(repo).as_posix())
    except ValueError:
        pass
    for rule in rules:
        regex = rule.get("path_regex")
        if not regex:
            return rule
        pattern = re.compile(str(regex))
        if any(pattern.search(candidate) for candidate in candidates):
            return rule
    return None


def key_is_encrypted(name: str, rule: dict) -> bool:
    unencrypted = rule.get("unencrypted_regex")
    if unencrypted and re.search(str(unencrypted), name):
        return False
    encrypted = rule.get("encrypted_regex")
    if encrypted:
        return re.search(str(encrypted), name) is not None
    return True


def leaf_values(value: object, prefix: list[str]):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from leaf_values(child, prefix + [str(key)])
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from leaf_values(child, prefix + [f"[{index}]"])
    else:
        yield prefix, value


def audit_secret(document: dict, rule: dict, location: str, policy_display: str) -> list[str]:
    problems: list[str] = []
    sops_meta = document.get("sops")
    if not isinstance(sops_meta, dict) or "mac" not in sops_meta:
        problems.append(f"{location}: Secret has no SOPS metadata block")

    def walk(value: object, ancestors: list[str]) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if not ancestors and key == "sops":
                    continue
                name = str(key)
                if key_is_encrypted(name, rule) or any(key_is_encrypted(item, rule) for item in ancestors):
                    for leaf_path, leaf in leaf_values(child, ancestors + [name]):
                        shown = ".".join(leaf_path)
                        if not isinstance(leaf, str) or not ENC_VALUE.match(leaf):
                            problems.append(
                                f"{location}: {shown} is not SOPS ciphertext (expected ENC[...])"
                            )
                else:
                    walk(child, ancestors + [name])
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, ancestors + [f"[{index}]"])

    walk(document, [])

    # Recipient match runs when the creation rule sets age. vm-staging rules
    # are required to set VM_STAGING_AGE_RECIPIENT; sops_guard rejects a file
    # that omits it. Skynet rules are checked separately and are unchanged.
    expected = age_recipients(rule)
    if isinstance(sops_meta, dict) and expected:
        found: list[str] = []
        for item in sops_meta.get("age") or []:
            if isinstance(item, dict) and item.get("recipient"):
                found.append(str(item["recipient"]))
        if any(recipient not in found for recipient in expected):
            problems.append(
                f"{location}: sops age recipients do not include the age recipient from {policy_display}"
            )
    return problems


def age_recipients(rule: dict) -> list[str]:
    age = rule.get("age")
    if not isinstance(age, str):
        return []
    return [part.strip() for part in age.split(",") if part.strip()]


def policy_is_vm_staging(policy: Path, repo: Path) -> bool:
    return "vm-staging" in policy.relative_to(repo).parts


# Public recipient only. The private key is not in this repo.
# docs/restructure-cutover.md
VM_STAGING_AGE_RECIPIENT = "age1pks7eeuqakm64nyy35m8fmwx4qh6lve4nt0xfevnue3xeu5er9eqa5skfp"
VM_STAGING_SOPS_POLICIES = (
    "clusters/vm-staging/.sops.yaml",
    "apps/vm-staging/.sops.yaml",
    "infrastructure/controllers/vm-staging/.sops.yaml",
    "monitoring/controllers/vm-staging/.sops.yaml",
    "monitoring/configs/vm-staging/.sops.yaml",
)


def sops_guard(repo: Path) -> list[str]:
    print("== SOPS guard ==")
    skynet_policy = repo / "clusters" / "skynet" / ".sops.yaml"
    failures: list[str] = []
    if not skynet_policy.is_file():
        failures.append("clusters/skynet/.sops.yaml is missing")
        return failures
    try:
        skynet_rules = load_creation_rules(skynet_policy)
    except (OSError, yaml.YAMLError, ValueError) as exc:
        failures.append(f"could not read clusters/skynet/.sops.yaml: {exc}")
        return failures
    if not skynet_rules:
        failures.append("clusters/skynet/.sops.yaml has no creation_rules")
    elif any(not age_recipients(rule) for rule in skynet_rules):
        failures.append(
            "clusters/skynet/.sops.yaml creation rule has no age recipient; "
            "skynet SOPS enforcement requires one"
        )

    root_policy = repo / ".sops.yaml"
    if root_policy.is_file() and skynet_policy.is_file():
        same = root_policy.read_text(encoding="utf-8") == skynet_policy.read_text(encoding="utf-8")
        print(
            "policy files: .sops.yaml and clusters/skynet/.sops.yaml are "
            + ("identical" if same else "different; each Secret uses the nearest file")
        )
    if root_policy.is_file():
        try:
            root_rules = load_creation_rules(root_policy)
        except (OSError, yaml.YAMLError, ValueError) as exc:
            failures.append(f"could not read .sops.yaml: {exc}")
            root_rules = []
        if root_rules and any(not age_recipients(rule) for rule in root_rules):
            failures.append(
                ".sops.yaml creation rule has no age recipient; "
                "skynet SOPS enforcement requires one"
            )

    referenced_examples: list[str] = []
    for kust_path in iter_yaml_files(repo):
        if kust_path.name not in KUSTOMIZATION_NAMES:
            continue
        try:
            data = yaml.safe_load(kust_path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            failures.append(f"{kust_path.relative_to(repo)}: {exc}")
            continue
        if not isinstance(data, dict):
            continue
        for key in ("resources", "components", "bases", "crds"):
            for item in data.get(key) or []:
                if isinstance(item, str) and is_example_secret(Path(item)):
                    referenced_examples.append(
                        f"{kust_path.relative_to(repo)} {key} includes {item}"
                    )
    if referenced_examples:
        failures.extend(
            f"example Secret is referenced by a Kustomization: {item}"
            for item in referenced_examples
        )

    checked = 0
    skipped: list[str] = []
    rules_cache: dict[Path, list[dict]] = {skynet_policy: skynet_rules}
    for path in iter_yaml_files(repo):
        if path.name != ".sops.yaml":
            continue
        relative = path.relative_to(repo).as_posix()
        try:
            rules = load_creation_rules(path)
        except (OSError, yaml.YAMLError, ValueError) as exc:
            failures.append(f"{relative}: {exc}")
            continue
        rules_cache[path] = rules
        if not policy_is_vm_staging(path, repo):
            continue
        if not rules:
            failures.append(f"{relative}: vm-staging .sops.yaml has no creation_rules")
            continue
        if any(age_recipients(rule) != [VM_STAGING_AGE_RECIPIENT] for rule in rules):
            failures.append(
                f"{relative}: vm-staging creation rule must set age to {VM_STAGING_AGE_RECIPIENT}"
            )
            continue
        print(f"SOPS recipient check enabled for {relative}")
    for relative in VM_STAGING_SOPS_POLICIES:
        if not (repo / relative).is_file():
            failures.append(f"{relative} is missing; vm-staging SOPS policy is required")
    for path in iter_yaml_files(repo):
        relative = path.relative_to(repo).as_posix()
        if is_example_secret(path):
            skipped.append(relative)
            continue
        try:
            documents = load_documents(path)
        except yaml.YAMLError as exc:
            if "kind: Secret" in path.read_text(encoding="utf-8"):
                failures.append(f"{relative}: YAML parse failed while checking Secrets: {exc}")
            continue
        for index, document in enumerate(documents):
            if not isinstance(document, dict) or document.get("kind") != "Secret":
                continue
            checked += 1
            policy = nearest_sops_policy(path, repo)
            location = f"{relative}#{index}"
            if policy is None:
                failures.append(f"{location}: no .sops.yaml applies to this Secret")
                continue
            if policy not in rules_cache:
                try:
                    rules_cache[policy] = load_creation_rules(policy)
                except (OSError, yaml.YAMLError, ValueError) as exc:
                    failures.append(f"{policy.relative_to(repo)}: {exc}")
                    continue
            rule = matching_rule(rules_cache[policy], path, policy, repo)
            if rule is None:
                failures.append(
                    f"{location}: no creation_rules entry in {policy.relative_to(repo)} matches this path"
                )
                continue
            failures.extend(
                audit_secret(document, rule, location, policy.relative_to(repo).as_posix())
            )

    print(f"checked {checked} Secret document(s)")
    if skipped:
        print("ignored plaintext templates that no Kustomization includes:")
        for name in skipped:
            print(f"  - {name}")
    if failures:
        print("SOPS guard failed")
    else:
        print("SOPS guard passed")
    return failures


def reject_network_kustomizations(repo: Path) -> list[str]:
    failures: list[str] = []
    for path in iter_yaml_files(repo):
        if path.name not in KUSTOMIZATION_NAMES:
            continue
        relative = path.relative_to(repo).as_posix()
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            failures.append(f"{relative}: {exc}")
            continue
        if not isinstance(data, dict):
            continue
        for key in ("helmCharts", "helmChartInflationGenerator", "generators", "transformers"):
            if data.get(key):
                failures.append(
                    f"{relative}: {key} can fetch remote content or run plugins; refused offline"
                )
        for key in ("resources", "components", "bases", "crds"):
            for item in data.get(key) or []:
                if isinstance(item, str) and re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", item):
                    failures.append(f"{relative}: remote {key} entry {item} is refused offline")
    return failures


def collect_generated_resources(directory: Path) -> list[str]:
    """Resources Flux would generate when a directory has no kustomization file.

    Hidden files (including .sops.yaml) are skipped. A subdirectory that
    already has a kustomization is included as one resource and not walked.
    """
    resources: list[str] = []

    def walk(current: Path) -> None:
        for entry in sorted(current.iterdir(), key=lambda item: item.name):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                if has_kustomization(entry):
                    resources.append(entry.relative_to(directory).as_posix())
                else:
                    walk(entry)
            elif entry.suffix in {".yaml", ".yml"}:
                resources.append(entry.relative_to(directory).as_posix())

    walk(directory)
    return resources


# Production and the second cluster. Paths inside them come from their
# Flux Kustomization manifests.
CLUSTER_ROOTS = ("clusters/skynet", "clusters/vm-staging")
APP_OVERLAY_ROOTS = ("apps/skynet", "apps/vm-staging")


def discover_flux_kustomizations(repo: Path) -> list[dict]:
    found: list[dict] = []
    for cluster in CLUSTER_ROOTS:
        base = repo / cluster
        if not base.is_dir():
            raise RuntimeError(f"{cluster} is missing")
        cluster_found = _flux_kustomizations_in(repo, base)
        if not cluster_found:
            raise RuntimeError(f"no Flux Kustomizations found under {cluster}")
        found.extend(cluster_found)
    return found


def _flux_kustomizations_in(repo: Path, base: Path) -> list[dict]:
    found: list[dict] = []
    for path in iter_yaml_files(base):
        try:
            documents = load_documents(path)
        except yaml.YAMLError as exc:
            raise RuntimeError(f"{path.relative_to(repo)}: {exc}") from exc
        for document in documents:
            if not isinstance(document, dict):
                continue
            api_version = str(document.get("apiVersion") or "")
            if document.get("kind") != "Kustomization" or not api_version.startswith(
                "kustomize.toolkit.fluxcd.io/"
            ):
                continue
            metadata = document.get("metadata") or {}
            spec = document.get("spec") or {}
            raw_path = str(spec.get("path") or "").strip()
            if raw_path.startswith("./"):
                raw_path = raw_path[2:]
            raw_path = raw_path.strip("/")
            if not raw_path:
                raise RuntimeError(
                    f"{path.relative_to(repo)}: Flux Kustomization {metadata.get('name')} has no spec.path"
                )
            found.append(
                {
                    "name": str(metadata.get("name") or ""),
                    "namespace": str(metadata.get("namespace") or "flux-system"),
                    "path": raw_path,
                    "postBuild": spec.get("postBuild"),
                    "source": path.relative_to(repo).as_posix(),
                }
            )
    return found


def discover_app_overlays(repo: Path) -> list[str]:
    overlays: list[str] = []
    for rel in APP_OVERLAY_ROOTS:
        apps = repo / rel
        if not apps.is_dir():
            raise RuntimeError(f"{rel} is missing")
        for dirpath, dirnames, _filenames in os.walk(apps):
            dirnames[:] = [name for name in dirnames if not name.startswith(".")]
            current = Path(dirpath)
            if current != apps and has_kustomization(current):
                overlays.append(current.relative_to(repo).as_posix())
    return sorted(overlays)


def enclosing_flux(relative: str, flux_items: list[dict]) -> dict | None:
    target = Path(relative)
    best: dict | None = None
    best_len = -1
    for item in flux_items:
        root = Path(item["path"])
        try:
            target.relative_to(root)
        except ValueError:
            continue
        if len(root.parts) > best_len:
            best = item
            best_len = len(root.parts)
    return best


def lookup_var(name: str, variables: dict[str, str], strict: bool) -> str:
    if name in variables:
        return variables[name]
    if strict:
        raise ValueError(f"postBuild variable {name} is not set")
    return ""


def eval_brace(expr: str, variables: dict[str, str], strict: bool) -> str:
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)(.*)$", expr, re.S)
    if not match:
        raise ValueError(f"unsupported postBuild expression ${{{expr}}}")
    name, rest = match.group(1), match.group(2)
    if not VAR_NAME.match(name):
        raise ValueError(f"invalid postBuild variable {name}")
    if rest == "":
        return lookup_var(name, variables, strict)
    value = variables.get(name, "")
    present = name in variables and value != ""
    if rest.startswith(":="):
        return value if present else rest[2:]
    if rest.startswith(":-"):
        return value if present else rest[2:]
    if rest.startswith(":+"):
        return rest[2:] if present else ""
    if rest.startswith(":?"):
        if not present:
            message = rest[2:] or f"{name} is not set"
            raise ValueError(message)
        return value
    if rest.startswith("//"):
        pattern, replacement = _split_replacement(rest[2:])
        return value.replace(pattern, replacement)
    if rest.startswith("/"):
        pattern, replacement = _split_replacement(rest[1:])
        return value.replace(pattern, replacement, 1)
    if rest.startswith(":") and not rest.startswith((":=", ":-", ":+", ":?")):
        return _bash_slice(value if name in variables else lookup_var(name, variables, strict), rest[1:])
    raise ValueError(f"unsupported postBuild operator in ${{{expr}}}")


def _split_replacement(body: str) -> tuple[str, str]:
    if "/" not in body:
        raise ValueError("postBuild replacement is missing '/'")
    pattern, replacement = body.split("/", 1)
    return pattern, replacement


def _bash_slice(value: str, spec: str) -> str:
    if ":" in spec:
        offset_text, length_text = spec.split(":", 1)
        if not re.fullmatch(r"-?\d+", offset_text) or not re.fullmatch(r"-?\d+", length_text):
            raise ValueError(f"unsupported postBuild slice :{spec}")
        offset = int(offset_text)
        length = int(length_text)
        if length < 0:
            raise ValueError("negative postBuild slice length is not supported")
    else:
        if not re.fullmatch(r"-?\d+", spec):
            raise ValueError(f"unsupported postBuild slice :{spec}")
        offset = int(spec)
        length = None
    if offset < 0:
        offset = max(0, len(value) + offset)
    if length is None:
        return value[offset:]
    return value[offset : offset + length]


def substitute_text(text: str, variables: dict[str, str], strict: bool) -> str:
    for name in variables:
        if not VAR_NAME.match(name):
            raise ValueError(f"invalid postBuild variable name {name}")
    out: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        if text[index] != "$":
            out.append(text[index])
            index += 1
            continue
        if index + 1 < length and text[index + 1] == "$":
            out.append("$")
            index += 2
            continue
        if index + 1 < length and text[index + 1] == "{":
            end = text.find("}", index + 2)
            if end < 0:
                raise ValueError("unclosed ${ in postBuild substitution")
            out.append(eval_brace(text[index + 2 : end], variables, strict))
            index = end + 1
            continue
        match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", text[index + 1 :])
        if not match:
            out.append("$")
            index += 1
            continue
        out.append(lookup_var(match.group(0), variables, strict))
        index += 1 + len(match.group(0))
    return "".join(out)


def substitution_disabled(document: str) -> bool:
    parsed = yaml.safe_load(document)
    if not isinstance(parsed, dict):
        return False
    metadata = parsed.get("metadata") or {}
    if not isinstance(metadata, dict):
        return False
    for section in ("annotations", "labels"):
        values = metadata.get(section) or {}
        if isinstance(values, dict) and values.get(SUBSTITUTE_ANNOTATION) == "disabled":
            return True
    return False


def apply_postbuild(rendered: str, post_build: object) -> str:
    if not post_build:
        return rendered
    if not isinstance(post_build, dict):
        raise ValueError("spec.postBuild is not a mapping")
    substitute_from = post_build.get("substituteFrom") or []
    if substitute_from:
        raise ValueError(
            "spec.postBuild.substituteFrom needs ConfigMaps or Secrets from the cluster; "
            "this job does not contact the cluster"
        )
    raw_vars = post_build.get("substitute") or {}
    if not isinstance(raw_vars, dict):
        raise ValueError("spec.postBuild.substitute is not a mapping")
    variables = {str(key): str(value).replace("\n", "") for key, value in raw_vars.items()}
    strategy = str(post_build.get("substituteStrategy") or "WithVariables")
    if strategy not in {"WithVariables", "Always"}:
        raise ValueError(f"unsupported substituteStrategy {strategy}")
    if not variables and strategy != "Always":
        return rendered
    rewritten: list[str] = []
    for document in split_documents(rendered):
        if substitution_disabled(document):
            rewritten.append(document)
            continue
        rewritten.append(substitute_text(document, variables, strict=True))
    return "\n---\n".join(part.strip("\n") for part in rewritten if part.strip()) + "\n"


def kustomize_build(directory: Path) -> str:
    generated: Path | None = None
    if not has_kustomization(directory):
        resources = collect_generated_resources(directory)
        if not resources:
            raise RuntimeError(f"no YAML manifests to build in {directory}")
        generated = directory / "kustomization.yaml"
        if generated.exists():
            raise RuntimeError(f"refusing to overwrite {generated}")
        body = (
            "apiVersion: kustomize.config.k8s.io/v1beta1\n"
            "kind: Kustomization\n"
            "resources:\n"
            + "".join(f"  - {item}\n" for item in resources)
        )
        generated.write_text(body, encoding="utf-8")
    try:
        completed = run(
            ["kustomize", "build", "--load-restrictor", "LoadRestrictionsNone", str(directory)],
            cwd=directory.parent,
        )
    finally:
        if generated is not None:
            generated.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise RuntimeError(redact(completed.stderr.strip() or completed.stdout.strip() or "kustomize build failed"))
    if completed.stderr.strip():
        print(redact(completed.stderr.strip()))
    return completed.stdout


def kubeconform(text: str, cache: Path) -> subprocess.CompletedProcess[str]:
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8") as handle:
        handle.write(text)
        name = handle.name
    try:
        return run(
            [
                "kubeconform",
                "-strict",
                "-summary",
                "-kubernetes-version",
                KUBERNETES_VERSION,
                "-cache",
                str(cache),
                # kubernetes-json-schema does not publish a CustomResourceDefinition
                # document (v1.36.3-standalone-strict/customresourcedefinition*.json
                # is absent). Skip that kind only. Do not use -ignore-missing-schemas;
                # every other kind must resolve.
                "-skip",
                "CustomResourceDefinition",
                "-schema-location",
                "default",
                "-schema-location",
                CRDS_CATALOG_URL,
                "-output",
                "text",
                name,
            ]
        )
    finally:
        Path(name).unlink(missing_ok=True)


def build_and_validate(repo: Path, relative: str, post_build: object, cache: Path) -> tuple[list[str], str]:
    directory = repo / relative
    if not directory.is_dir():
        return [f"{relative}: path does not exist"], ""
    try:
        rendered = kustomize_build(directory)
        rendered = apply_postbuild(rendered, post_build)
    except (RuntimeError, ValueError, yaml.YAMLError) as exc:
        return [f"{relative}: {exc}"], ""
    prepared = prepare_for_kubeconform(rendered)
    if re.search(r"(?m)^sops:", prepared):
        return [f"{relative}: sops metadata survived schema preparation"], ""
    completed = kubeconform(prepared, cache)
    summary = ""
    for line in reversed((completed.stdout or "").splitlines()):
        if line.startswith("Summary:"):
            summary = line
            break
    if completed.returncode != 0:
        detail = redact((completed.stdout or "") + (completed.stderr or "")).strip()
        return [f"{relative}: kubeconform failed\n{detail}"], summary
    return [], summary


def manifest_checks(repo: Path) -> list[str]:
    print("== kustomize + kubeconform ==")
    failures = reject_network_kustomizations(repo)
    if failures:
        print("refusing remote kustomize inputs")
        return failures
    try:
        flux_items = discover_flux_kustomizations(repo)
    except RuntimeError as exc:
        return [str(exc)]
    if not flux_items:
        return ["no Flux Kustomizations found under clusters/skynet or clusters/vm-staging"]

    print(
        "kubeconform -strict"
        f" -kubernetes-version {KUBERNETES_VERSION}"
        f" -schema-location default and datreeio/CRDs-catalog@{CRDS_CATALOG_SHA[:12]}"
    )
    print(
        "CustomResourceDefinition is skipped because kubernetes-json-schema does not "
        "publish that document. -ignore-missing-schemas is not set. "
        "The sops key is removed only in the kubeconform input; Flux strips it on decrypt."
    )
    print("Flux roots:")
    for item in flux_items:
        post = item["postBuild"]
        post_note = "postBuild set" if post else "no postBuild"
        print(
            f"  - {item['namespace']}/{item['name']} -> {item['path']} "
            f"({post_note}, from {item['source']})"
        )
    try:
        overlays = discover_app_overlays(repo)
    except RuntimeError as exc:
        return [str(exc)]
    print("app overlays:")
    for overlay in overlays:
        print(f"  - {overlay}")

    targets: list[tuple[str, object]] = []
    seen: set[str] = set()
    for item in flux_items:
        if item["path"] in seen:
            continue
        seen.add(item["path"])
        # If two Flux Kustomizations share a path, their postBuild must agree.
        siblings = [other for other in flux_items if other["path"] == item["path"]]
        post_builds = [other["postBuild"] for other in siblings]
        if any(post != post_builds[0] for post in post_builds):
            failures.append(f"{item['path']}: Flux Kustomizations disagree on postBuild")
            continue
        targets.append((item["path"], item["postBuild"]))
    for overlay in overlays:
        if overlay in seen:
            continue
        owner = enclosing_flux(overlay, flux_items)
        targets.append((overlay, owner["postBuild"] if owner else None))
        seen.add(overlay)
    for cluster in CLUSTER_ROOTS:
        if cluster not in seen:
            targets.append((cluster, None))
            seen.add(cluster)
    # kubectl apply -k uses this directory. The root Kustomization's path is
    # the parent, so discovery does not build it on its own.
    flux_system = "clusters/vm-staging/flux-system"
    if flux_system not in seen:
        targets.append((flux_system, None))
        seen.add(flux_system)

    cache = Path(tempfile.mkdtemp(prefix="kubeconform-"))
    try:
        for relative, post_build in targets:
            problems, summary = build_and_validate(repo, relative, post_build, cache)
            if problems:
                failures.extend(problems)
                print(f"FAIL {relative}")
            else:
                print(f"OK   {relative}  {summary}")
    finally:
        shutil.rmtree(cache, ignore_errors=True)
    if not failures:
        print("kustomize and kubeconform passed")
    return failures


def yamllint(repo: Path) -> list[str]:
    print("== yamllint ==")
    config = repo / ".yamllint.yaml"
    if not config.is_file():
        return [".yamllint.yaml is missing"]
    completed = run([sys.executable, "-m", "yamllint", "-c", str(config), "."], cwd=repo)
    if completed.stdout.strip():
        print(redact(completed.stdout.strip()))
    if completed.returncode != 0:
        print("yamllint failed")
        return ["yamllint failed"]
    print("yamllint passed")
    return []


def self_test() -> None:
    assert substitute_text("a ${FOO} b", {"FOO": "x"}, strict=True) == "a x b"
    assert substitute_text("pre $FOO post", {"FOO": "x"}, strict=True) == "pre x post"
    assert substitute_text("$$FOO", {}, strict=True) == "$FOO"
    assert substitute_text("${MISSING:=zz}", {}, strict=True) == "zz"
    assert substitute_text("${SET:=zz}", {"SET": "v"}, strict=True) == "v"
    assert substitute_text("${EMPTY:-zz}", {"EMPTY": ""}, strict=True) == "zz"
    assert substitute_text("${FOO:1:2}", {"FOO": "abcd"}, strict=True) == "bc"
    assert substitute_text("${FOO/a/b}", {"FOO": "a-a"}, strict=True) == "b-a"
    assert substitute_text("${FOO//a/b}", {"FOO": "a-a"}, strict=True) == "b-b"
    try:
        substitute_text("${MISSING}", {}, strict=True)
    except ValueError:
        pass
    else:
        raise AssertionError("strict substitution accepted an unset variable")
    try:
        apply_postbuild("apiVersion: v1\nkind: ConfigMap\n", {"substituteFrom": [{"kind": "ConfigMap", "name": "x"}]})
    except ValueError:
        pass
    else:
        raise AssertionError("substituteFrom was accepted")

    secret = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "example"},
        "stringData": {"token": "ENC[AES256_GCM,data:abc,type:str]"},
        "sops": {"mac": "ENC[x]", "age": [{"recipient": "age1test"}]},
    }
    rule = {"path_regex": r".*\.yaml", "encrypted_regex": r"^(data|stringData)$", "age": "age1test"}
    assert audit_secret(secret, rule, "mem#0", ".sops.yaml") == []
    secret["stringData"]["token"] = "plaintext"
    assert audit_secret(secret, rule, "mem#0", ".sops.yaml")
    # A rule with no age still skips only the recipient comparison.
    # Repo vm-staging policies are not allowed to use that: sops_guard requires
    # VM_STAGING_AGE_RECIPIENT on each of them.
    unset_age = {"path_regex": r".*\.yaml", "encrypted_regex": r"^(data|stringData)$"}
    encrypted = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "example"},
        "stringData": {"token": "ENC[AES256_GCM,data:abc,type:str]"},
        "sops": {"mac": "ENC[x]", "age": [{"recipient": "age1other"}]},
    }
    assert age_recipients(unset_age) == []
    assert audit_secret(encrypted, unset_age, "mem#1", "apps/vm-staging/.sops.yaml") == []
    encrypted["stringData"]["token"] = "plaintext"
    assert audit_secret(encrypted, unset_age, "mem#1", "apps/vm-staging/.sops.yaml")
    assert audit_secret(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "stringData": {"token": "ENC[AES256_GCM,data:abc,type:str]"},
            "sops": {"mac": "ENC[x]", "age": [{"recipient": "age1other"}]},
        },
        rule,
        "mem#2",
        "clusters/skynet/.sops.yaml",
    )
    staging_rule = {
        "path_regex": r".*\.yaml",
        "encrypted_regex": r"^(data|stringData)$",
        "age": VM_STAGING_AGE_RECIPIENT,
    }
    assert audit_secret(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "stringData": {"token": "ENC[AES256_GCM,data:abc,type:str]"},
            "sops": {"mac": "ENC[x]", "age": [{"recipient": "age1other"}]},
        },
        staging_rule,
        "mem#3",
        "apps/vm-staging/.sops.yaml",
    )
    assert audit_secret(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "stringData": {"token": "ENC[AES256_GCM,data:abc,type:str]"},
            "sops": {"mac": "ENC[x]", "age": [{"recipient": VM_STAGING_AGE_RECIPIENT}]},
        },
        staging_rule,
        "mem#4",
        "apps/vm-staging/.sops.yaml",
    ) == []
    assert is_example_secret(Path("apps/skynet/node-red/node-red-admin-secret.example.yaml"))
    assert is_example_secret(
        Path("infrastructure/controllers/base/cloudflared/tunnel-token.secret.yaml.example")
    )
    assert not is_example_secret(Path("apps/skynet/node-red/node-red-admin-secret.yaml"))
    assert policy_is_vm_staging(Path("apps/vm-staging/.sops.yaml"), Path("."))
    assert not policy_is_vm_staging(Path("clusters/skynet/.sops.yaml"), Path("."))

    raw = "apiVersion: v1\nkind: Secret\nsops:\n  mac: ENC[x]\nstringData:\n  token: ENC[abc]\n"
    stripped = strip_top_level_sops(raw)
    assert "sops:" not in stripped
    assert "token:" in stripped
    assert substitution_disabled(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  annotations:\n    "
        + SUBSTITUTE_ANNOTATION
        + ": disabled\n"
    )


def require_tools() -> list[str]:
    missing = []
    for tool in ("kustomize", "kubeconform"):
        if shutil.which(tool) is None:
            missing.append(f"{tool} is not on PATH")
    return missing


def main() -> int:
    if "--self-test" in sys.argv:
        self_test()
        print("self-test passed")
        return 0
    self_test()
    failures = require_tools()
    if failures:
        for item in failures:
            eprint(item)
        return 1
    print(f"repo: {REPO_ROOT}")
    failures.extend(sops_guard(REPO_ROOT))
    failures.extend(manifest_checks(REPO_ROOT))
    failures.extend(yamllint(REPO_ROOT))
    print("== result ==")
    if failures:
        print(f"{len(failures)} check(s) failed")
        for item in failures:
            eprint(item)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
