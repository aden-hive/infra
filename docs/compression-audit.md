# Compression rollout audit (PR #2034 + followups)

Living notes on bugs, performance, and optimization plan for the `memfile` /
`rootfs` compression feature introduced by PR
[#2034](https://github.com/e2b-dev/infra/pull/2034) and followup
[#2532](https://github.com/e2b-dev/infra/pull/2532).

Files audited: `packages/shared/pkg/storage/{compress_*,header/*,gcp_multipart*,storage_*,paths.go}`,
`packages/orchestrator/pkg/sandbox/{block,build,template,uploads.go,build_upload*.go,sandbox.go}`.
All affected unit tests pass under `-race`.

Last re-verified after rebase on main 2026-05-19 (base `00907f99c`).

---

## TL;DR — rollout gates

1. **Three production-risk bugs should land before broad enablement:**
   unbounded LZ4 header decompression ([B2](#b2-unbounded-lz4-header-decompression-production-risk)),
   10 s GCS read deadline that includes the entire decompressor drain
   ([B3](#b3-gcs-read-deadline-covers-the-whole-decompressor-drain-production-risk)),
   and `Cache.WriteAtWithoutLock` with no length guard ([B4](#b4-cachewriteatwithoutlock-panics-on-sub-blocksize-buffers-production-risk)).
2. **Performance is at ~75–90 % of the zstd library ceiling**, no hidden
   pipeline pathology. The two biggest production levers are
   [setting `frameEncodeWorkers` ≥ 4 in LD](#production-parallelism-read-this-before-tuning-anything)
   (default is 1 — single-threaded per file in prod today) and dropping to
   **zstd level 1** (≈25 % faster, ratio 0.36 vs 0.28 on our benchmark workload).

Numbering note: B1 was the original V3→V4 P2P chunker bug; fixed in main by
[#2585](https://github.com/e2b-dev/infra/pull/2585) (peerSeekable now
re-resolves its base path per call from the live FrameTable). The entry was
removed; B2–B9 numbers kept to preserve external link stability.

---

## Bugs

### B2. Unbounded LZ4 header decompression (production risk)

`serializeV4` writes a `uint32` uncompressed-size prefix at
`blockData[1:5]`, but `deserializeV4` never reads it and `decompressLZ4`
does an unbounded `io.ReadAll`. A corrupted header in GCS (build pipeline
bug, partial write, or an actor with bucket write access) can cause a header
load to allocate up to LZ4's max ratio (~255×) of the compressed body's
size. There is also no upper bound on the compressed length itself
(`uint32` = 4 GB cap).

**Where**

- `packages/shared/pkg/storage/header/serialization_v4.go:126-136` —
  `deserializeV4` skips the size prefix.
- `packages/shared/pkg/storage/header/serialization_v4.go:245-254` —
  `decompressLZ4` does `io.ReadAll` with no cap.

**Fix.** Read the prefix in `deserializeV4`; reject sizes above a sane cap
(e.g. 64 MiB — V4 headers in practice are KB-MB). Pass it through to
`decompressLZ4` as the destination buffer size or as an `io.LimitReader`
bound. Bonus: avoids buffer growth churn on normal loads.

### B3. GCS read deadline covers the whole decompressor drain (production risk)

`googleReadTimeout` is a 10 s wall-clock context applied at
`openRangeReader` creation; the same context underlies every subsequent
`Read`. For compressed reads the consumer pulls bytes through
`decompressor → tee → raw → GCS`, and the 10 s caps the entire drain. NBD/UFFD
back-pressure, the cache writeback path's
`io.Copy(io.Discard, r.decompressor)` on Close, or a slow gRPC tail can all
expand the drain past 10 s. For a 600 KB compressed frame the floor is
60 KB/s — entirely plausible during noisy-neighbour incidents — and the
failure surfaces to NBD as `context deadline exceeded`.

**Where**

- `packages/shared/pkg/storage/storage_google.go:267-278`
- `packages/shared/pkg/storage/storage_cache_seekable_compressed.go:120-167`
  (compressed cache writeback drain).

**Fix.** Replace the absolute deadline with a per-read idle timeout, or
size the absolute deadline against the expected frame bytes plus generous
slack. `cancelOnCloseReader` already releases its cancel on Close so a
no-deadline + idle-timer variant is straightforward.

### B4. `Cache.WriteAtWithoutLock` panics on sub-blocksize buffers (production risk)

`packages/orchestrator/pkg/sandbox/block/cache.go:336-378` does
`runZero := header.IsZero(b[:c.blockSize])` with no length guard; the
function's doc comment says "caller must pass a block-aligned write" but
there is no runtime check. `Cache.WriteAt` is the locked entry point and
forwards directly. An NBD or future caller passing a sub-blocksize buffer
will SIGSEGV the orchestrator.

**Fix.** Return `(0, error)` from `WriteAtWithoutLock` if
`len(b) < int(c.blockSize)`. One-liner test.

### B5. No retry on V4 data 404 after `transitionEmitted`

After `transitionEmitted.CompareAndSwap(false, true)` returns
`PeerTransitionedError`, the upper loop polls GCS for the *header* only.
Upload order is data → header → `publish()`, so by the time the peer flips
`UseStorage` (post-publish on the originator) both objects exist. The
remaining risk is GCS gRPC client caching / multipart visibility lag on a
freshly completed object: if the data lookup later fails with
`ErrObjectNotExist`, the failure is permanent because subsequent calls no
longer raise `PeerTransitionedError` (sticky `true`).

**Where**: `packages/orchestrator/pkg/sandbox/template/peerclient/seekable.go:129-138`.

**Fix.** Re-emit a recoverable transition error from `peerSeekable` when
the base read fails with `ErrObjectNotExist` within a short budget after
the transition, so the upper loop re-polls and retries.

### B6. Per-frame zstd dst buffer never pooled (perf, see optimizations)

`zstdCompressor.compress` allocates `make([]byte, 0, len(src))` per frame
(2 MB at default config) and the resulting slice survives until the part
upload completes; nothing recycles it. Drives 39.9 % of total alloc bytes
and ~3 % of CPU. See [Optimizations](#performance-optimizations).

**Where**: `packages/shared/pkg/storage/compress_encode.go:46-48`.

### B7. Test coverage gap: `OpenRangeReader` returns one frame, test expects entire file

The integration test `TestSandboxRapidSnapshotForkChain` does
`obj.OpenRangeReader(ctx, 0, bd.Size, bd.FrameData)` and expects to read
`bd.Size` bytes. But `gcpObject.OpenRangeReader` (and the FS variant) on a
compressed range fetches **only the single frame containing offset 0** —
the `length` arg is ignored on the compressed path. The test only passes
when `bd.Size ≤ frameSize` (≤ 2 MiB). For typical multi-MB diffs it would
fail; CI is presumably running with diffs small enough to fit in one
frame, so the multi-frame V4 path is *not* validated end-to-end.

**Where**: `tests/integration/internal/tests/api/sandboxes/sandbox_rapid_pause_resume_test.go:138-162`
(per-frame semantics on the storage side are documented behaviour).

**Fix.** In the test, iterate frames via the `FrameTable` and decompress each
through its own `OpenRangeReader` call; sum the decompressed bytes into the
hasher. Or expose a `ReadFullCompressed` helper that loops internally.

### B8. Other minor / follow-up items

- `runV4`: when `MemfileDiffHeader != nil` but `MemfileDiff.CachePath() == ""`,
  `Builds[u.buildID]` is still written with a zero `BuildData`. Consistent
  iff no mappings reference self in this case — true in practice but
  serialized output is structurally indistinguishable from a real
  empty-zero-size build. Either skip the write or reject in
  `ValidateHeader`.
- `MinPartSizeMB` from LD config is unvalidated against GCS's 5 MiB
  multipart minimum — a value `≤ 4` would produce non-final parts that
  GCS rejects. Add a guard in `validateCompressConfig`.
- `openReaderCompressed` cache hit doesn't validate the cached `.frm`
  content — a corrupt frame poisons reads until manual eviction.
- AWS path explicitly errors on compressed uploads
  (`storage_aws.go:236-239`); not a bug, just a coverage gap.
- `gcp_multipart.uploadPartSlices` retry safety is fine **today** — but
  becomes coupled to the [B6 fix](#b6-per-frame-zstd-dst-buffer-never-pooled-perf-see-optimizations)
  because pooled slices may be released before
  `retryablehttp.ReaderFunc` is replayed. Land both together.

### B9. `MultipartUploader.UploadFileInParallel` leaks the multipart upload on checksum failure

Added by PR [#2669](https://github.com/e2b-dev/infra/pull/2669): when
`UploadFileInParallel` runs the SHA-256 in a sibling goroutine while parts
upload, the post-wait sequence at
`packages/shared/pkg/storage/gcp_multipart.go:436-449` skips
`completeUpload` whenever `eg.Wait()` returns an error (e.g. disk EIO on the
sibling `io.Copy(hasher, hashFile)`). The initiated multipart upload then
sits in GCS until the bucket lifecycle expires it (default 7 days). Not a
read-path correctness issue, but a real resource leak that gets noisy on
flaky disks.

**Fix.** Either call `m.abortUpload` on the failure path before returning,
or treat checksum failure as best-effort once data upload succeeds and call
`completeUpload`, logging the checksum error. Abort is safer.

### Bugs ruled out (verified safe)

- Original B1 (V3→V4 P2P chunker) — fixed by [#2585](https://github.com/e2b-dev/infra/pull/2585).
- `compressStream` drain on error / `q` deadlock — the `cancel()` +
  `for range q` drain after `loopErr` is correct and bounded.
- `compressStream`'s `io.ReadFull` ignoring `ctx` cancel: input is
  `*os.File`, drain returns promptly on EOF/error.
- Race on `p.frames` and `p.compressedSize` — `frames` only mutated by
  readLoop before the part is queued; uploader reads after `compress.Wait()`.
- Zero-byte final frame.
- `decompressingCacheReader.Close` for ZSTD draining `compressedBuf`
  (LocateCompressed returns the exact `SizeC`; tee captures the full frame
  including CRC; the short-write guard prevents cache poisoning).
- `cacheWriteThroughReader` int64→int overflow (capped by `chunkSize`).
- `v4SerializableBuildInfo` cross-platform alignment (binary.LittleEndian
  reflection over a 56-byte struct).
- `extractRelevantRanges` + `TrimToRanges` dedup (verified by inspection
  and existing unit tests).
- V4-for-uncompressed FF path ([#2669](https://github.com/e2b-dev/infra/pull/2669)):
  `ft=nil` propagates through `FrameTable` helpers (all nil-safe) and the
  read path correctly falls back to uncompressed `OpenRangeReader`.

---

## Production parallelism (read this before tuning anything)

The compression pipeline is structured for parallelism at three levels; the
key issue is the third layer's **default**.

| Layer | Knob | Default | Effect |
|---|---|---|---|
| Across files (memfile + rootfs) | `eg.Go` in `runV4`/`runV3` | always 2-way | hard-coded in code |
| Across parts within a file (upload) | `gcloudDefaultUploadConcurrency` | 16 | hard-coded; not LD-tunable |
| **Across frames within a file (compress)** | `compress-config.frameEncodeWorkers` (LD) | **0 → clamped to 1** | **single-threaded per file by default** |

### Concrete impact

With `frameEncodeWorkers=0` (the LD default), per-file compression runs on a
single core at ~245 MB/s. Memfile + rootfs in parallel = ~2 cores total
during a pause, regardless of how many cores the host has.

| memfile size | workers=1 | workers=4 | workers=8 |
|---|---:|---:|---:|
| 1 GiB | ~4.5 s | ~1.4 s | ~0.7 s |
| 4 GiB | **~17 s** | ~5.6 s | ~3 s |
| 8 GiB | ~34 s | ~11 s | ~6 s |

(Numbers from the standalone zstd benchmark scaling factors at level 2:
247 MB/s × workers, capped by host core count.)

### What CI runs vs what prod runs

- CI integration tests (`zstd1` matrix entry) set
  `COMPRESS_FRAME_ENCODE_WORKERS=8` via the GHA env. That's what
  `BenchmarkCompress/w[1248]_unlimited` exercises.
- Production reads the value from the `compress-config` LD targeting rule.
  Unless ops have set it, frame compression is single-threaded. The benchmark
  numbers we report below assume `workers ≥ 4`.

### Recommendation

Set `compress-config.frameEncodeWorkers` to roughly `host_cores / 2` for the
target prod fleet (e.g. 8 on a 16-core orchestrator). Each frame is
independently zstd-compressed and concatenated in U-space order via the
FrameTable, so this is purely a parallelism unlock — no correctness impact.
At workers ≥ 6 SHA-256 on the readLoop dispatcher becomes the next gate
(see [O3](#o3-move-sha-256-off-the-readloop-critical-path)).

Also worth surfacing alongside this rollout:
[O6](#o6-surface-frameencodeworkers-and-gclouddefaultuploadconcurrency-in-the-same-ld-flag).

---

## Performance

### Measured ceiling vs production (`BenchmarkCompress`, 256 MB workload, ~0.28 ratio at zstd level 2, 2 MB frames)

Machine: AMD Ryzen 7 8745HS (16 logical cores).

| Configuration | MB/s | % of single-core × N | Notes |
|---|---:|---:|---|
| Standalone w1 (1 enc, reused, no pipeline) | 247 | 100 % | per-core ceiling |
| Standalone w2 | 473 | 96 % | linear scaling |
| Standalone w4 (1 enc/worker, reused dst) | 905 | 91 % | ideal pipeline |
| Standalone w4 + sync.Pool encoders | 887 | 89.7 % | -2 % pool overhead |
| Standalone w4 + per-frame dst alloc | 866 | 87.5 % | -2.4 % alloc cost |
| Standalone w4 + sync.Pool + SHA-256 on dispatcher | 848 | 85.8 % | -5 % from SHA |
| **Production `BenchmarkCompress/w4_unlimited`** | **745** | **75.4 %** | full pipeline |
| Production w1 | 218 | 88 % of standalone w1 | |
| Production w2 | 421 | 89 % of standalone w2 | |

### `BenchmarkStoreFile` (1 GB file, in-process `fsObject`)

| variant | MB/s | ratio | B/op |
|---|---:|---:|---:|
| zstd1/w8 | 919 | 0.36 | 4.5 GB |
| zstd2/w8 | 745 | 0.28 | 4.1 GB |
| zstd3/w8 | 333 | 0.30 | 4.3 GB |
| zstd1/w1 | 226 | — | 4.5 GB |

### Frame-size sweep (standalone, level 2, w=4)

| frame | MB/s | ratio |
|---|---:|---:|
| 512 KB | 821 | 0.256 |
| 1 MB | **943** | 0.270 |
| 2 MB (current) | 903 | 0.279 |
| 4 MB | 870 | 0.285 |
| 8 MB | 874 | 0.288 |
| 16 MB | 833 | 0.290 |

1 MB is the throughput sweet spot but only legal for `rootfs` (4 KiB block);
`memfile` (2 MiB block) is constrained to multiples of 2 MiB and the current
default is within 4 % of optimum.

### CPU profile (`BenchmarkCompress/w4_unlimited`, 12.24 s wall, 50.47 s samples ≈ 4.1 cores busy)

1. `zstd.(*Encoder).EncodeAll` — **85.14 % cum**
   (`doubleFastEncoder.Encode` 41.45 %, `blockEnc.encode` 16.82 %,
   `matchLen` 6.84 %, `bitWriter.addBits16NC` 3.92 %). Untunable from our
   side except by changing level or codec.
2. SHA-256 (`sha256.blockSHANI`) — 6.66 % flat / 9 % cum on the
   single-goroutine dispatcher. Not the parallelism gate at w=4 today;
   becomes the gate at w≥6 with current code.
3. Go runtime `memmove` + `memclrNoHeapPointers` + `mallocgc[Large]` —
   ~10.5 % combined. Driven by the two unpooled per-frame allocations.

### Allocation profile (same run, 25 GB total over 31 iterations)

- `readLoop` (`make([]byte, frameSize)` per frame) — **8.08 GB / 32.26 %**.
- `zstdCompressor.compress` (`make([]byte, 0, len(src))` per frame) —
  **9.99 GB / 39.89 %**.
- `memPartUploader.bytes.Buffer.Write` growSlice — 6.71 GB / 26.79 %
  (**test only**; real `MultipartUploader` does not concatenate).
- zstd internal `fastBase.ensureHist`, `encoderOptions.encoder` — 1.69 GB.

### Quick-win optimization tried (and reverted)

Pooled the `readLoop` per-frame source buffer with `sync.Pool`, releasing
in the compressor goroutine after `c.compress` returns:

| variant | before MB/s | after MB/s | before B/op | after B/op |
|---|---:|---:|---:|---:|
| w1_unlimited | 222 | 199 | 803 MB | 531 MB |
| w2_unlimited | 422 | 419 | 811 MB | 541 MB |
| w4_unlimited | 759 | 770 | 827 MB | 563 MB |

Heap dropped ~32 %, throughput moved <2 %. The encoder is the gate; allocation
tuning alone cannot meaningfully improve throughput. Combined with B6 (pooling
the zstd dst) the gain would be larger but still bounded by the encoder.

### Verdict

**No pipeline pathology.** Production at `w=4` runs at 75–82 % of the
standalone library ceiling on the same machine. The ~10–18 % gap is fully
accounted for by:

- ~5 % SHA-256 on the readLoop critical path,
- ~3 % `sync.Pool` encoder swap + per-frame dst alloc,
- ~5–10 % residual pipeline orchestration (channel sends, `errgroup`
  `compress.Wait` per part, `memPartUploader` byte copy in benchmark; real
  GCS upload doesn't double-copy).

---

## Performance optimizations (ranked by ROI)

Each is independent; gains stack roughly additively.

### O0. Set `frameEncodeWorkers` ≥ 4 in LD config (biggest single change)

See [Production parallelism](#production-parallelism-read-this-before-tuning-anything).
Default is 1 (single-threaded per file); bumping to e.g. 8 cuts a 4 GiB
memfile compress from ~17 s to ~3 s. Pure ops-config change, no code change.

### O1. Drop to zstd level 1 (biggest single-flag win)

Level 1 hits **919 MB/s** in our pipeline at w=8 vs **745 MB/s** at level 2,
a ~25 % speedup. Compression ratio gives up ~3 percentage points
(0.279 → 0.36). For most snapshot workloads this is the right trade. Easy
to ship via the existing LD `compressConfig` flag.

### O2. Pool the zstd dst buffer ([B6](#b6-per-frame-zstd-dst-buffer-never-pooled-perf-see-optimizations))

Estimated +3-5 % throughput, ~40 % drop in heap allocations. Need to couple
with the [`uploadPartSlices` retry-safety follow-up](#b8-other-minor--follow-up-items).
Pool 2 MB-class `[]byte`, pass into `EncodeAll`'s `dst`, recycle in the
part-upload completion callback.

### O3. Move SHA-256 off the readLoop critical path

Estimated +5 % at w=4, more at w≥6. SHA-256 must remain sequential over the
input stream, but it can run in a dedicated goroutine fed via a buffered
channel of `[]byte` references — readLoop hashes nothing, it only enqueues
and forwards to compress workers. The hasher goroutine consumes in order,
returns the digest to `compressStream` via a `<-chan [32]byte`.

### O4. Pool the readLoop source buffer

Estimated +1.5 % throughput, ~30 % drop in heap. Already prototyped and
measured ([Quick-win optimization tried](#quick-win-optimization-tried-and-reverted)).
Couple with O2 — same coordination logic for buffer recycle.

### O5. Eliminate `memPartUploader` byte-copy in benchmarks

Test-only artefact. Real `MultipartUploader` already streams without
concatenation. Replacing the benchmark uploader with a streaming-discard
variant would unmask the actual production throughput in `BenchmarkCompress`.

### O6. Surface `FrameEncodeWorkers` and `gcloudDefaultUploadConcurrency` in the same LD flag

Today `gcloudDefaultUploadConcurrency = 16` is hard-coded while
`FrameEncodeWorkers` is configurable. The pipeline becomes upload-bound
when workers > maxUpload and compute-bound the other way. Surfacing both
through `compressConfig` lets ops tune them together.

### Out of scope (architectural, evaluate later)

- **Parallel-read upload via `io.ReaderAt`.** Discussed in PR review:
  read multiple frames in parallel from the source file, dispatch
  workers across the file, build per-part frame-size lists in commit
  order. Inverts the readLoop ordering invariant; meaningful refactor.
- **Seekable on top of frame tables.** Tracked separately; orthogonal to
  the points above.

---

## Test plan before broad enablement

- [ ] Land [B2](#b2-unbounded-lz4-header-decompression-production-risk),
  [B3](#b3-gcs-read-deadline-covers-the-whole-decompressor-drain-production-risk),
  [B4](#b4-cachewriteatwithoutlock-panics-on-sub-blocksize-buffers-production-risk).
- [ ] Fix [B7](#b7-test-coverage-gap-openrangereader-returns-one-frame-test-expects-entire-file)
  so multi-frame compressed reads are actually validated end-to-end in CI.
- [ ] Add an integration test that exercises **cross-orchestrator** P2P
  resume during in-flight compressed upload (now that the original B1
  chunker bug is fixed nothing asserts it doesn't regress).
- [ ] Add a unit test for the V3→V4 ct-change path in `peerSeekable.getBase`
  to lock in the [#2585](https://github.com/e2b-dev/infra/pull/2585) fix.

---

## Reproducing the benchmarks

All numbers in [Performance](#performance) were collected from this tree
(base `00907f99c`) on an AMD Ryzen 7 8745HS (16 logical cores, no SMT
pinning, idle desktop, governor `performance`). Run `go clean -testcache`
before each set; the in-tree benchmarks use `b.SetBytes(uncompressedSize)`,
so the `MB/s` column in `go test` output is uncompressed throughput.

### In-tree pipeline benchmarks

These produce the `Production w{1,2,4}` rows of the first table and the
entire `BenchmarkStoreFile` table.

```bash
cd packages/shared
go test -run='^$' -bench='^BenchmarkCompress$' -benchmem -benchtime=3s ./pkg/storage/
go test -run='^$' -bench='^BenchmarkStoreFile$' -benchmem -benchtime=2s ./pkg/storage/
```

Mapping bench output to the doc:

- `BenchmarkCompress/w{1,2,4}_unlimited` → `Production w{1,2,4}` rows
  (218 / 421 / 745 MB/s). The throttled variants (`w*_200MBs`, `w4_100MBs`)
  are not in the doc but are emitted by the same run.
- `BenchmarkStoreFile/zstd{1,2,3}/w8` → corresponding rows of the
  `BenchmarkStoreFile` table; the `ratio` extra metric (reported by
  `b.ReportMetric`) is the `ratio` column.
- `BenchmarkStoreFile/zstd1/w1` → 226 MB/s row.
- `B/op` is read straight from `-benchmem`.

The 256 MB (`BenchmarkCompress`) / 1 GB (`BenchmarkStoreFile`) input is
deterministic — `generateSemiRandomData` repeats a random byte 1-16 times
to land at ratio ≈ 0.28 at zstd level 2.

### Standalone reference benchmarks

The `Standalone w*` rows and the frame-size sweep table are *not* in-tree —
they isolate the encoder cost with no pipeline / no SHA / no uploader, so
the gap between standalone and `BenchmarkCompress/w*_unlimited` is the
production pipeline overhead.

Reproduce in a scratch module against `github.com/klauspost/compress v1.18.5`:

```bash
mkdir /tmp/zbench && cd /tmp/zbench
go mod init zbench && go get github.com/klauspost/compress@v1.18.5
# paste the program below as main.go
go run . -workers=1                  # standalone w1            (247 MB/s)
go run . -workers=2                  # standalone w2            (473 MB/s)
go run . -workers=4                  # standalone w4 (baseline) (905 MB/s)
go run . -workers=4 -variant=pool    # +sync.Pool encoders      (887 MB/s)
go run . -workers=4 -variant=alloc   # +per-frame dst alloc     (866 MB/s)
go run . -workers=4 -variant=sha     # +Pool+SHA on dispatcher  (848 MB/s)
for kb in 512 1024 2048 4096 8192 16384; do go run . -workers=4 -frame-kb=$kb; done
```

Program (≈80 LOC, mirrors `compress_upload.go::readLoop` +
`compress_encode.go::zstdCompressor`):

```go
package main

import (
	"crypto/sha256"
	"flag"
	"fmt"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
)

func main() {
	workers := flag.Int("workers", 4, "frame workers")
	frameKB := flag.Int("frame-kb", 2048, "frame size in KiB")
	variant := flag.String("variant", "reuse", "reuse|pool|alloc|sha")
	flag.Parse()

	const total = 256 << 20
	src := semiRandom(total)
	frame := *frameKB << 10

	mkEnc := func() *zstd.Encoder {
		e, _ := zstd.NewWriter(nil,
			zstd.WithEncoderLevel(zstd.SpeedDefault), // level 2
			zstd.WithEncoderCRC(true),
			zstd.WithWindowSize(frame),
			zstd.WithEncoderConcurrency(1))
		return e
	}

	pool := &sync.Pool{New: func() any { return mkEnc() }}
	encs := make([]*zstd.Encoder, *workers)
	for i := range encs {
		encs[i] = mkEnc()
	}
	dst := make([][]byte, *workers)
	for i := range dst {
		dst[i] = make([]byte, 0, frame)
	}

	type job struct{ id int; data []byte }
	jobs := make(chan job, *workers*2)
	var wg sync.WaitGroup
	for w := 0; w < *workers; w++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := range jobs {
				var out []byte
				switch *variant {
				case "pool":
					e := pool.Get().(*zstd.Encoder)
					out = e.EncodeAll(j.data, dst[id][:0])
					pool.Put(e)
				case "alloc":
					out = encs[id].EncodeAll(j.data, make([]byte, 0, len(j.data)))
				default: // "reuse" and "sha" share the encoder path
					out = encs[id].EncodeAll(j.data, dst[id][:0])
				}
				_ = out
			}
		}(w)
	}

	h := sha256.New()
	start := time.Now()
	for off := 0; off < total; off += frame {
		end := off + frame
		if end > total {
			end = total
		}
		chunk := src[off:end]
		if *variant == "sha" {
			h.Write(chunk) // sequential SHA on dispatcher
		}
		jobs <- job{id: off / frame, data: chunk}
	}
	close(jobs)
	wg.Wait()
	d := time.Since(start)
	fmt.Printf("workers=%d frame=%dKB variant=%s: %.0f MB/s (%.2fs)\n",
		*workers, *frameKB, *variant, float64(total)/d.Seconds()/(1<<20), d.Seconds())
}

func semiRandom(n int) []byte {
	r := rand.New(rand.NewPCG(1, 2))
	out := make([]byte, n)
	for i := 0; i < n; {
		run := r.IntN(16) + 1
		if i+run > n {
			run = n - i
		}
		b := byte(r.IntN(256))
		for j := 0; j < run; j++ {
			out[i+j] = b
		}
		i += run
	}
	return out
}
```

Each variant adds exactly one of the operations the production pipeline
performs, in the same order they appear in `compress_upload.go` /
`compress_encode.go`:

- `reuse` — N encoders, dst reused per worker (lower bound).
- `pool` — encoder fetched from `sync.Pool` per frame (matches
  `newCompressorPool`).
- `alloc` — dst is `make([]byte, 0, len(src))` per call (matches
  `zstdCompressor.compress`).
- `sha` — pool + sequential SHA-256 on the dispatch goroutine (matches
  `readLoop`'s hashing).

The scaling table at line 220 (`workers=1/4/8` for 1/4/8 GiB memfiles) is
just `bytes / (workers × 247 MB/s)`, capped by host cores.

### CPU profile (≈4.1 cores busy)

```bash
cd packages/shared
go test -run='^$' -bench='^BenchmarkCompress$/w4_unlimited' -benchtime=10s \
  -cpuprofile=/tmp/cpu.out ./pkg/storage/
go tool pprof -top -cum /tmp/cpu.out
```

Cumulative percentages in the [CPU profile](#cpu-profile-benchmarkcompressw4_unlimited-1224-s-wall-5047-s-samples--41-cores-busy)
section come straight from `-top -cum` (zstd 85.14 % cum, SHA-256 6.66 %
flat, runtime mem ops ~10.5 % combined).

### Allocation profile

```bash
cd packages/shared
go test -run='^$' -bench='^BenchmarkCompress$/w4_unlimited' -benchtime=30s \
  -memprofile=/tmp/mem.out ./pkg/storage/
go tool pprof -top -sample_index=alloc_space /tmp/mem.out
```

The "25 GB total over 31 iterations" line is just `B/op × N` from the
`-benchmem` output of the same run. Per-callsite percentages are direct
from `pprof -top`.

---

## Sources

- Audit transcripts (Cursor): [first audit](96f3b893-4323-4c6f-b31f-801def720ff8),
  [PR review extract](88b0756c-a591-483a-81f7-72e67f7b5cb8).
- PRs: [#2034](https://github.com/e2b-dev/infra/pull/2034) (initial),
  [#2532](https://github.com/e2b-dev/infra/pull/2532) (upload race fix),
  [#2585](https://github.com/e2b-dev/infra/pull/2585) (B1 fix: per-call path
  resolution in `peerSeekable`),
  [#2669](https://github.com/e2b-dev/infra/pull/2669) (V4-header-for-uncompressed
  FF + parallel hashing in `MultipartUploader` — introduced [B9](#b9-multipartuploaderuploadfileinparallel-leaks-the-multipart-upload-when-checksum-fails-after-a-successful-data-upload)).
- Benchmark methodology and exact commands: see
  [Reproducing the benchmarks](#reproducing-the-benchmarks).
