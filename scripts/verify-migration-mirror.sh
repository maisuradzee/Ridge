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

expected=1
for name in "${source_files[@]}"; do
  number=$((10#${name:0:4}))
  if [[ "$number" -ne "$expected" ]]; then
    echo "Migration sequence gap: expected $(printf '%04d' "$expected"), found $name." >&2
    exit 1
  fi
  if ! cmp -s "$source_dir/$name" "$embedded_dir/$name"; then
    echo "Migration mirror differs: $name" >&2
    diff -u "$source_dir/$name" "$embedded_dir/$name" || true
    exit 1
  fi
  expected=$((expected + 1))
done

echo "Verified ${#source_files[@]} ordered SQL migrations; source and embedded copies are identical."
