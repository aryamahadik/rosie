#!/usr/bin/env bash
# Creates the private R2 bucket behind the FILES binding (T-441; DL-027; Master Corrections C10). Safe to run
# again: it looks for the bucket first and changes nothing when it exists. Wrangler runs only through cf.sh
# (the Rosfield sign-in and the pinned account). The bucket is private: it is never given an r2.dev URL or a
# custom domain. Reads the state of both after every run and fails when either is on, or when the script cannot
# tell; it turns the r2.dev URL off when it finds it on (the bucket's own default), and removes no domain.
# Usage: infra/scripts/create-r2-bucket.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Keep in step with wrangler.jsonc's r2_buckets[].bucket_name.
BUCKET="rosie-staging-files"

# Prints "yes" or "no": is $BUCKET in the account's bucket list? (wrangler lists "name:  <bucket>" lines)
bucket_exists() {
  local listing
  listing="$("$CF" r2 bucket list)" || die "could not list the R2 buckets"
  if printf '%s\n' "$listing" | grep -Eq "^name:[[:space:]]+${BUCKET}[[:space:]]*$"; then
    printf 'yes'
  else
    printf 'no'
  fi
}

if [[ "$(bucket_exists)" == "yes" ]]; then
  log "R2 bucket $BUCKET already exists: not created again"
else
  log "R2 bucket $BUCKET does not exist: creating it"
  "$CF" r2 bucket create "$BUCKET" >/dev/null || die "could not create the R2 bucket $BUCKET"
  [[ "$(bucket_exists)" == "yes" ]] || die "created $BUCKET but it is not in the bucket list"
  log "R2 bucket $BUCKET created"
fi

# Public access, part 1: the r2.dev URL. Off is the default; turn it off when it is on.
dev_url="$("$CF" r2 bucket dev-url get "$BUCKET")" || die "could not read the r2.dev state of $BUCKET"
if printf '%s\n' "$dev_url" | grep -Eiq 'disabled'; then
  log "r2.dev public URL of $BUCKET: disabled"
elif printf '%s\n' "$dev_url" | grep -Eiq 'enabled|https://pub-'; then
  log "r2.dev public URL of $BUCKET is enabled: turning it off"
  "$CF" r2 bucket dev-url disable "$BUCKET" --force >/dev/null || die "could not disable the r2.dev URL of $BUCKET"
  dev_url="$("$CF" r2 bucket dev-url get "$BUCKET")" || die "could not re-read the r2.dev state of $BUCKET"
  printf '%s\n' "$dev_url" | grep -Eiq 'disabled' || die "the r2.dev URL of $BUCKET is still on"
  log "r2.dev public URL of $BUCKET: disabled"
else
  die "could not tell the r2.dev state of $BUCKET"
fi

# Public access, part 2: custom domains. None is ever added here; one found is reported, not removed.
domains="$("$CF" r2 bucket domain list "$BUCKET")" || die "could not read the custom domains of $BUCKET"
if printf '%s\n' "$domains" | grep -Eiq '^domain:'; then
  die "$BUCKET has a custom domain (public access): remove it in the Cloudflare dashboard"
fi
log "custom domains of $BUCKET: none"

log "R2 bucket $BUCKET is private: no r2.dev URL, no custom domain"
