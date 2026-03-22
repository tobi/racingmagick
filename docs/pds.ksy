meta:
  id: pds
  title: Pi / Cosworth PDS telemetry container
  application: RacecraftViewer
  file-extension: pds
  endian: le
  ks-version: 0.10
  license: MIT

# IMPORTANT:
# This schema intentionally models only the stable container pieces:
# - file header (directory location / count)
# - directory entries
# - raw section spans
#
# The actual channel-definition and chunk-record formats vary between PDS families.
# Use this schema to parse the top-level structure, then perform adaptive probing in code:
# 1) inspect consecutive directory entries
# 2) identify a plausible definitions block
# 3) identify a plausible chunk block
# 4) validate candidate record layouts against in-bounds data
#
# Known variants seen so far:
# - legacy: large defs table, duplicated channel ids in chunk records
# - compact export: small defs table, fixed 64-byte chunks, no duplicate channel id

seq:
  - id: preamble
    size: 0x80
  - id: directory
    type: directory_block

types:
  directory_block:
    seq:
      - id: entries
        type: directory_entry
        repeat: expr
        repeat-expr: _root.directory_entry_count

  directory_entry:
    seq:
      - id: offset_lo
        type: u4
      - id: offset_hi
        type: u4
      - id: count
        type: u4
      - id: unknown_c
        type: u4
      - id: class_a
        type: u4
      - id: class_b
        type: u4
      - id: next_count
        type: u4
      - id: reserved
        type: u4
    instances:
      offset:
        value: (offset_hi << 32) | offset_lo
      is_candidate_defs:
        value: class_a == 1 and class_b == 1 and count > 0

instances:
  directory_entry_count:
    pos: 0x88
    type: u4

  # Convenience: expose every three-entry window so a host parser can inspect them.
  candidate_triplets:
    value: directory.entries

  # Raw file size is useful for validating spans.
  file_size:
    value: _io.size

# Suggested host-side algorithm (not expressible robustly in Kaitai alone for this format family):
#
# for i in 0..<(entries.count - 2):
#   defs = entries[i]
#   chunk = entries[i + 1]
#   next = entries[i + 2]
#
#   reject unless defs.offset < chunk.offset < next.offset <= file_size
#
#   # candidate definition block:
#   # - try defs.offset, defs.offset - 8, and first nearby marker (0x7c72 / 0x7c70)
#   # - score record alignments by whether they decode to plausible channel records
#
#   # candidate chunk block:
#   # - legacy: variable width, duplicated channel id, chunk count from defs.next_count
#   # - compact: fixed 64 bytes, chunk count from chunk.count, no duplicated id field
#
#   # accept the first layout with enough valid records.
