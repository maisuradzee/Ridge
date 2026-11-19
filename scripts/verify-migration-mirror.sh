#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/backend/migrations"
embedded_dir="$root/backend/internal/migrations/sql"

if [[ ! -d "$source_dir" || ! -d "$embedded_dir" ]]; then
  echo "Migration directories are missing." >&2
  exit 1
fi

mapfile -t source_files < <(find "$source_dir" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort)
mapfile -t embedded_files < <(find "$embedded_dir" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort)

if [[ "${#source_files[@]}" -eq 0 ]]; then
  echo "No numbered SQL migrations found." >&2
  exit 1
fi

if [[ "${source_files[*]}" != "${embedded_files[*]}" ]]; then
  echo "Migration filename mismatch between source and embedded directories." >&2
  diff -u <(printf '%s\n' "${source_files[@]}") <(printf '%s\n' "${embedded_files[@]}") || true
  exit 1
fi

# The embedded runner owns the transaction boundary. The standalone SQL files
# may retain outer BEGIN/COMMIT wrappers for manual psql execution, so compare
# the SQL bodies after removing only those exact wrapper lines.
normalize() {
  sed -E '/^[[:space:]]*(BEGIN|COMMIT);[[:space:]]*$/Id' "$1"
}

expected=1
for name in "${source_files[@]}"; do
  number=$((10#${name:0:4}))
  if [[ "$number" -ne "$expected" ]]; then
    echo "Migration sequence gap: expected $(printf '%04d' "$expected"), found $name." >&2
    exit 1
  fi
  if ! diff -u <(normalize "$source_dir/$name") <(normalize "$embedded_dir/$name"); then
    echo "Migration SQL body differs: $name" >&2
    exit 1
  fi
  expected=$((expected + 1))
done

echo "Verified ${#source_files[@]} ordered migrations; SQL bodies match and transaction wrappers are handled separately."
