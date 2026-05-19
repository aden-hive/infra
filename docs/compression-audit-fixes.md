# Compression audit — fix sketches

Code-level sketches for the open bugs in [compression-audit.md](./compression-audit.md).
Each sketch is intentionally minimal: smallest diff that closes the issue
plus a unit-test outline. Numbers track the audit's `B*` IDs.

These are not landed PRs — each section is meant to be the basis for one
small, reviewable change.

---

## B2 — Cap LZ4 header decompression at the on-the-wire size

`packages/shared/pkg/storage/header/serialization_v4.go`

```go
// v4MaxUncompressedHeaderSize bounds the LZ4 expansion. V4 headers in
// practice are KB–MB; pick a cap well above realistic worst case but well
// below "blow up the orchestrator".
const v4MaxUncompressedHeaderSize = 64 << 20 // 64 MiB

func deserializeV4(metadata *Metadata, blockData []byte) (*Header, error) {
    if len(blockData) < v4FlagsLen+v4SizePrefixLen {
        return nil, fmt.Errorf("v4 header block too short for flags + size prefix: %d bytes", len(blockData))
    }

    flags := blockData[0]
    size := binary.LittleEndian.Uint32(blockData[v4FlagsLen:])
    if size > v4MaxUncompressedHeaderSize {
        return nil, fmt.Errorf("v4 header uncompressed size %d exceeds cap %d", size, v4MaxUncompressedHeaderSize)
    }

    decompressed, err := decompressLZ4(blockData[v4FlagsLen+v4SizePrefixLen:], int(size))
    if err != nil {
        return nil, fmt.Errorf("failed to LZ4-decompress v4 header block: %w", err)
    }
    if len(decompressed) != int(size) {
        return nil, fmt.Errorf("v4 header decompressed size %d != prefix %d", len(decompressed), size)
    }
    // ...rest unchanged...
}

func decompressLZ4(src []byte, expected int) ([]byte, error) {
    r := lz4.NewReader(bytes.NewReader(src))
    dst := make([]byte, 0, expected)
    buf := bytes.NewBuffer(dst)
    if _, err := io.CopyN(buf, r, int64(expected)+1); err != nil && !errors.Is(err, io.EOF) {
        return nil, fmt.Errorf("lz4 decompress: %w", err)
    }
    return buf.Bytes(), nil
}
```

Test outline:

- Round-trip a normal V4 header — bytes match (no behavior change).
- Forge a block where the prefix says `1 << 20` but the LZ4 frame expands
  to `2 << 20` — `deserializeV4` rejects.
- Forge a prefix above the cap — `deserializeV4` rejects without
  attempting decompression.

---

## B3 — Replace the GCS absolute deadline with a per-read idle timer

`packages/shared/pkg/storage/storage_google.go`

The 10 s `googleReadTimeout` currently caps the entire `Read` lifetime,
which means a slow consumer (UFFD back-pressure, decompressor drain, cache
write-back) can convert harmless slowness into hard failure. Switch to a
per-`Read` idle timer; the absolute timeout becomes the connection-open
budget only.

```go
const (
    googleReadOpenTimeout = 10 * time.Second // bounds NewRangeReader
    googleReadIdleTimeout = 30 * time.Second // bounds gap between Reads
)

func (o *gcpObject) openRangeReader(ctx context.Context, off, length int64) (io.ReadCloser, error) {
    openCtx, openCancel := context.WithTimeout(ctx, googleReadOpenTimeout)
    defer openCancel()

    reader, err := o.handle.NewRangeReader(openCtx, off, length)
    if err != nil {
        return nil, fmt.Errorf("failed to create GCS range reader for %q at %d+%d: %w", o.path, off, length, err)
    }

    // Read lifetime uses a fresh cancel that the per-Read idle timer arms.
    readCtx, readCancel := context.WithCancel(ctx)
    return &idleTimeoutReader{
        ReadCloser: reader,
        ctx:        readCtx,
        cancel:     readCancel,
        idle:       googleReadIdleTimeout,
    }, nil
}

// idleTimeoutReader cancels the GCS stream context if no Read completes
// within `idle`. Each successful Read resets the timer.
type idleTimeoutReader struct {
    io.ReadCloser
    ctx    context.Context
    cancel context.CancelFunc
    idle   time.Duration
    timer  *time.Timer
}

func (r *idleTimeoutReader) Read(p []byte) (int, error) {
    if r.timer == nil {
        r.timer = time.AfterFunc(r.idle, r.cancel)
    } else {
        r.timer.Reset(r.idle)
    }
    n, err := r.ReadCloser.Read(p)
    if err != nil {
        r.timer.Stop()
    }
    return n, err
}

func (r *idleTimeoutReader) Close() error {
    if r.timer != nil {
        r.timer.Stop()
    }
    defer r.cancel()
    return r.ReadCloser.Close()
}
```

Apply the same swap inside `WriteTo` (`storage_google.go:345`) — that path
also uses the 10 s absolute deadline today.

Test outline (`storage_google_test.go`):

- Fake handle whose `Read` sleeps 2 s between byte chunks and emits 6
  chunks. Total wall time 12 s > old 10 s deadline. With the new reader
  this succeeds (each gap is under the 30 s idle).
- Fake handle that stalls forever after first byte → reader cancels at
  idle deadline, returns `context.DeadlineExceeded`.

---

## B4 — Length guard on `Cache.WriteAtWithoutLock`

`packages/orchestrator/pkg/sandbox/block/cache.go`

```go
// When using WriteAtWithoutLock you must ensure thread safety...
func (c *Cache) WriteAtWithoutLock(b []byte, off int64) (int, error) {
    if c.isClosed() {
        return 0, NewErrCacheClosed(c.filePath)
    }
    if c.mmap == nil {
        return 0, nil
    }

    // NBD/UFFD invariant: writes are block-aligned and at least one block
    // wide. A short buffer would panic on the IsZero check below.
    if int64(len(b)) < c.blockSize {
        return 0, fmt.Errorf("WriteAtWithoutLock: buffer %d < blockSize %d", len(b), c.blockSize)
    }
    if off%c.blockSize != 0 {
        return 0, fmt.Errorf("WriteAtWithoutLock: offset %d not block-aligned (%d)", off, c.blockSize)
    }

    // ...existing body...
}
```

Test outline:

- `WriteAtWithoutLock(make([]byte, blockSize/2), 0)` returns an error
  instead of panicking.
- `WriteAtWithoutLock(make([]byte, blockSize), blockSize/2)` returns an
  error (misaligned).
- `WriteAtWithoutLock(make([]byte, blockSize), 0)` succeeds (status quo).

---

## B5 — Recoverable transition error on post-transition data 404

`packages/orchestrator/pkg/sandbox/template/peerclient/seekable.go`

Today `transitionEmitted` is a single boolean; once flipped, every later
call fall-throughs to base regardless of what base returns. Track a short
"just transitioned" budget and re-emit the recoverable error when base
reports `ErrObjectNotExist` inside that window.

```go
type peerSeekable struct {
    peerHandle

    basePersistence storage.StorageProvider
    objType         storage.SeekableObjectType

    mu     sync.Mutex
    base   storage.Seekable
    baseCT storage.CompressionType
    loaded bool

    transitionEmitted atomic.Bool
    // transitionAt is set to time.Now() the first time CompareAndSwap flips
    // transitionEmitted true. Used to bound the retry-on-404 window.
    transitionAt atomic.Int64
}

const postTransitionRetryBudget = 30 * time.Second

func (s *peerSeekable) OpenRangeReader(ctx context.Context, off, length int64, frameTable *storage.FrameTable) (io.ReadCloser, error) {
    // ...peer attempt unchanged...

    if s.uploaded != nil && s.uploaded.Load() && s.transitionEmitted.CompareAndSwap(false, true) {
        s.transitionAt.Store(time.Now().UnixNano())
        return nil, &storage.PeerTransitionedError{}
    }

    base, err := s.getBase(ctx, frameTable.CompressionType())
    if err != nil {
        return nil, err
    }

    rc, err := base.OpenRangeReader(ctx, off, length, frameTable)
    if errors.Is(err, storage.ErrObjectNotExist) && s.withinTransitionWindow() {
        // GCS just-finalized object may be transiently invisible to a
        // fresh gRPC client. Re-emit so File.retryOnTransition reloads
        // the header and the upper loop retries.
        return nil, &storage.PeerTransitionedError{}
    }
    return rc, err
}

func (s *peerSeekable) withinTransitionWindow() bool {
    at := s.transitionAt.Load()
    if at == 0 {
        return false
    }
    return time.Since(time.Unix(0, at)) < postTransitionRetryBudget
}
```

`File.retryOnTransition` does not need changes; reloading the header on
each re-emission is the right behavior because the object becoming
visible coincides with whatever GCS-side delay was in play.

Test outline (`seekable_test.go`):

- Base provider that returns `ErrObjectNotExist` once then succeeds:
  with `transitionEmitted=true`, first call returns
  `PeerTransitionedError`; second call succeeds.
- Same provider, but advance fake clock past 30 s before the second
  call: second call returns `ErrObjectNotExist` (no infinite retry).

---

## B6 — Pool the zstd `dst` buffer

`packages/shared/pkg/storage/compress_encode.go` +
`packages/shared/pkg/storage/compress_upload.go`

The dst buffer is currently allocated per frame and survives until the
part is uploaded. Coupled fix per the audit: pool 2 MiB-class `[]byte`,
recycle in the part-upload completion callback (must coordinate with
`uploadPartSlices` retry; the buffer can only be released once the part
has either succeeded or definitively failed).

```go
// dstBufferPool holds frame-sized scratch buffers reused across frames.
// Sized by the first allocation; sync.Pool drops stale entries during GC.
var dstBufferPool = sync.Pool{
    New: func() any {
        b := make([]byte, 0, DefaultCompressFrameSize)
        return &b
    },
}

func getDstBuffer(want int) []byte {
    b := dstBufferPool.Get().(*[]byte)
    if cap(*b) < want {
        *b = make([]byte, 0, want)
    }
    return (*b)[:0]
}

func putDstBuffer(b []byte) {
    if cap(b) == 0 {
        return
    }
    b = b[:0]
    dstBufferPool.Put(&b)
}

func (z *zstdCompressor) compress(src []byte) ([]byte, error) {
    dst := getDstBuffer(len(src))
    return z.enc.EncodeAll(src, dst), nil
}
```

Recycle on the upload side — the dst slice is the `frame.compressed` field
held by `*part`. After the uploader is done with the part, return each
frame's buffer:

```go
// compress_upload.go — compressStream uploader goroutine
work.Go(func() error {
    err := uploader.UploadPart(workCtx, pi, compressed...)
    for _, f := range p.frames {
        putDstBuffer(f.compressed)
        f.compressed = nil
    }
    return err
})
```

Coupling with `uploadPartSlices`: the retryable HTTP client may replay
`bodyFn` after `UploadPart` returns a retryable status. The retry happens
*inside* `m.client.Do(req)`, which itself returns before `UploadPart`
returns. So recycling after `UploadPart` is safe.

Test outline:

- Run a 100 MiB compressStream and assert the dst pool's `New` is called
  ≤ `frameEncodeWorkers + 1` times (roughly steady-state).
- Race test: parallel `compressStream` invocations on independent buffers
  — no cross-pollution.

---

## B7 — Multi-frame compressed read in the rapid-pause-resume test

`tests/integration/internal/tests/api/sandboxes/sandbox_rapid_pause_resume_test.go`

The current test reads one frame and then asserts total bytes equal
`bd.Size`. Iterate via the `FrameTable` instead.

```go
func verifyChecksum(t *testing.T, ctx context.Context, persistence storage.StorageProvider, node chainNode, paths storage.Paths, fileName string, objType storage.SeekableObjectType, bd header.BuildData) {
    t.Helper()

    if bd.Size == 0 {
        return
    }

    dataPath := paths.DataFile(fileName, bd.FrameData.CompressionType())
    obj, err := persistence.OpenSeekable(ctx, dataPath, objType)
    require.NoErrorf(t, err, "%s/%s: open data file %s", node.name, fileName, dataPath)

    hasher := sha256.New()
    var total int64

    // FrameTable iterates frames in U-space order.
    for i := 0; i < bd.FrameData.NumFrames(); i++ {
        startU, endU, _, _ := bd.FrameData.FrameAt(i)

        rc, err := obj.OpenRangeReader(ctx, startU, endU-startU, bd.FrameData)
        require.NoErrorf(t, err, "%s/%s: open frame %d", node.name, fileName, i)

        n, err := io.Copy(hasher, rc)
        rc.Close()
        require.NoErrorf(t, err, "%s/%s: stream frame %d", node.name, fileName, i)
        total += n
    }

    require.Equalf(t, bd.Size, total, "%s/%s: streamed bytes (%d) differ from BuildData.Size (%d)", node.name, fileName, total, bd.Size)

    var got [32]byte
    copy(got[:], hasher.Sum(nil))
    require.Equalf(t, bd.Checksum, got, "%s/%s: data SHA-256 does not match BuildData.Checksum", node.name, fileName)
}
```

Note: `FrameAt` is uncompressed-only — for the uncompressed branch,
`bd.FrameData` is `nil` and `NumFrames()` returns 0. The test already
no-ops on `bd.Size == 0`; for the V4-uncompressed FF path, add a
`ft == nil` short-circuit that streams the single object directly. A
small `ReadFullCompressed` helper on `Seekable` would hide both branches
behind one method and keep the test loop boring.

---

## B8 — Minor / follow-up items

### B8a — Zero `BuildData` written for V4 self-entry on empty diff

`packages/orchestrator/pkg/sandbox/build_upload_v4.go`

```go
h := srcHeader.CloneForUpload(headers.MetadataVersionV4)
h.IncompletePendingUpload = false
if h.Builds == nil {
    h.Builds = make(map[uuid.UUID]headers.BuildData)
}

if err := u.appendAncestorBuilds(ctx, h.Builds, srcHeader.Mapping, fileType); err != nil {
    return err
}

// Only record self when we actually uploaded data. An empty diff leaves
// no entry — readers fall through to the mapping for the parent.
if srcPath != "" {
    h.Builds[u.buildID] = selfBuild
}
```

Test: serialize a header with an empty self-diff, deserialize, assert
`Builds[selfID]` is absent.

### B8b — Validate `MinPartSizeMB` ≥ GCS 5 MiB minimum

`packages/orchestrator/pkg/sandbox/build_upload.go` —
`validateCompressConfig`:

```go
const gcsMinPartSizeMB = 5

func validateCompressConfig(c storage.CompressConfig, blockSize uint64) error {
    fs := c.FrameSize()
    if fs <= 0 {
        return fmt.Errorf("frame size must be positive, got %d KB", c.FrameSizeKB)
    }
    if blockSize == 0 {
        return errors.New("block size must be positive")
    }
    if uint64(fs)%blockSize != 0 {
        return fmt.Errorf("frame size (%d) must be a multiple of block size (%d)", fs, blockSize)
    }
    if c.MinPartSizeMB > 0 && c.MinPartSizeMB < gcsMinPartSizeMB {
        return fmt.Errorf("min part size %d MiB below GCS multipart minimum %d MiB", c.MinPartSizeMB, gcsMinPartSizeMB)
    }
    return nil
}
```

Test: `MinPartSizeMB=1` → error; `MinPartSizeMB=5` → ok; `MinPartSizeMB=0`
→ ok (falls back to default).

### B8c — Validate cached `.frm` content on cache hit

`packages/shared/pkg/storage/storage_cache_seekable_compressed.go`

A corrupt frame on NFS poisons reads until manual eviction. Cheapest
defence: the FrameTable already encodes per-frame `SizeC`. Stat the cache
file on open and reject when sizes disagree; let the read path fall
through to a fresh fetch (which will overwrite the bad file via
write-back). Stronger defence (CRC) needs new on-disk format.

```go
f, err := os.Open(path)
switch {
case err == nil:
    if fi, statErr := f.Stat(); statErr == nil && fi.Size() != int64(r.Length) {
        f.Close()
        recordCacheReadError(ctx, cacheTypeSeekable, cacheOpOpenRangeReader,
            fmt.Errorf("cached frame %s size %d != expected %d", path, fi.Size(), r.Length))
        // fall through to miss path — overwrite on close.
        _ = os.Remove(path)
        break
    }
    // ...existing hit handling...
```

Test: pre-populate the cache with a truncated `.frm`, open via
`openReaderCompressed`, expect a successful read served from the upstream
and the cache file rewritten correctly.

---

## B9 — Abort the multipart upload on checksum failure

`packages/shared/pkg/storage/gcp_multipart.go`

Add an `abortUpload` method (XML API `DELETE` on the upload URL) and call
it on any failure path where parts succeeded but a sibling check did not.

```go
func (m *MultipartUploader) abortUpload(ctx context.Context, uploadID string) error {
    url := fmt.Sprintf("%s/%s?uploadId=%s", m.baseURL, m.objectName, uploadID)
    req, err := retryablehttp.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
    if err != nil {
        return err
    }
    req.Header.Set("Authorization", "Bearer "+m.token)

    resp, err := m.client.Do(req)
    if err != nil {
        return fmt.Errorf("abort upload: %w", err)
    }
    defer resp.Body.Close()
    // 204 = aborted; 404 = already gone (also fine).
    if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound {
        body, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("abort upload failed (status %d): %s", resp.StatusCode, body)
    }
    return nil
}

func (m *MultipartUploader) UploadFileInParallel(ctx context.Context, filePath string, maxConcurrency int, hasher hash.Hash) (int64, error) {
    // ...unchanged up to uploadParts/eg.Wait...

    parts, err := m.uploadParts(ctx, maxConcurrency, numParts, fileSize, file, uploadID)
    if hashFile != nil && err != nil {
        hashFile.Close()
    }
    if hashErr := eg.Wait(); err == nil {
        err = hashErr
    }
    if err != nil {
        if abortErr := m.abortUpload(context.WithoutCancel(ctx), uploadID); abortErr != nil {
            logger.L().Warn(ctx, "failed to abort multipart upload after error",
                zap.String("upload_id", uploadID), zap.Error(abortErr))
        }
        return 0, fmt.Errorf("failed to upload file: %w", err)
    }

    if err := m.completeUpload(ctx, uploadID, parts); err != nil {
        if abortErr := m.abortUpload(context.WithoutCancel(ctx), uploadID); abortErr != nil {
            logger.L().Warn(ctx, "failed to abort multipart upload after complete error",
                zap.String("upload_id", uploadID), zap.Error(abortErr))
        }
        return 0, fmt.Errorf("failed to complete upload: %w", err)
    }
    return fileSize, nil
}
```

Two notes:

- `context.WithoutCancel(ctx)` so the abort still runs when the caller's
  context is what caused the failure.
- Same `abortUpload` call should be added to the compressed path
  (`storeFileCompressed` → `compressStream`); the symmetric leak exists
  there if `compressStream` fails after `Start` has run.

Test (`gcp_multipart_test.go`): inject a checksum-step failure via a
hasher whose `Write` returns an error after N bytes. Assert that the
mock GCS server saw an `abortUpload` DELETE for the upload ID.

---

## Suggested landing order

Independent enough to land in any order, but a reasonable sequence:

1. **B4** (one-line guard, zero risk) — closes a SIGSEGV pathway.
2. **B2** (size-prefix cap) — closes the DoS-from-storage pathway.
3. **B8a / B8b** (validation tightening) — small, defensive.
4. **B9** (abort multipart on failure) — resource leak fix; pairs with
   #2669.
5. **B3** (idle timer) — touches the hot read path, more careful review;
   ship behind a feature flag if rollout is risky.
6. **B5** (transition window) — narrow scenario, but ties off the open
   end of #2585.
7. **B7** (test fix) — gates broad enablement honesty.
8. **B6 + B8c** (perf + cache validation) — landed together with the
   `uploadPartSlices` coupling note.
