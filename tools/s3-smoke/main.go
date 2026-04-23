// s3-smoke exercises packages/shared/pkg/storage against an S3-compatible
// endpoint (OVH Object Storage, MinIO, Ceph RGW). Round-trips PUT, GET,
// range read, multipart, presigned URL.
//
//	STORAGE_PROVIDER=AWSBucket \
//	AWS_ENDPOINT_URL_S3=http://host:9000 AWS_S3_USE_PATH_STYLE=true \
//	AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
//	TEMPLATE_BUCKET_NAME=e2b-templates \
//	go run ./tools/s3-smoke
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/e2b-dev/infra/packages/shared/pkg/storage"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	provider, err := storage.GetStorageProvider(ctx, storage.TemplateStorageConfig)
	must(err)
	log.Printf("provider: %s", provider.GetDetails())

	const key = "s3-smoke/roundtrip.bin"

	blob, err := provider.OpenBlob(ctx, key, storage.MetadataObjectType)
	must(err)

	small := []byte("hello e2b s3 compat")
	must(blob.Put(ctx, small))
	log.Printf("PUT %d bytes → %s", len(small), key)

	var buf bytes.Buffer
	_, err = blob.WriteTo(ctx, &buf)
	must(err)
	if !bytes.Equal(buf.Bytes(), small) {
		log.Fatalf("GET mismatch: got %q want %q", buf.String(), string(small))
	}
	log.Printf("GET matches (%d bytes)", buf.Len())

	seek, err := provider.OpenSeekable(ctx, key, storage.MemfileObjectType)
	must(err)

	rc, err := seek.OpenRangeReader(ctx, 6, 3)
	must(err)
	got, err := io.ReadAll(rc)
	rc.Close()
	must(err)
	if string(got) != "e2b" {
		log.Fatalf("range read mismatch: got %q want e2b", got)
	}
	log.Printf("RANGE read matches: %q", got)

	sz, err := seek.Size(ctx)
	must(err)
	log.Printf("HEAD size: %d", sz)

	const mpKey = "s3-smoke/multipart.bin"
	big := make([]byte, 25*1024*1024)
	_, _ = rand.Read(big)
	tmp, err := os.CreateTemp("", "s3-smoke-mp-*")
	must(err)
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(big)
	must(err)
	tmp.Close()

	mpBlob, err := provider.OpenSeekable(ctx, mpKey, storage.MemfileObjectType)
	must(err)
	must(mpBlob.StoreFile(ctx, tmp.Name()))
	log.Printf("MULTIPART upload OK (%d bytes)", len(big))

	mpSz, err := mpBlob.Size(ctx)
	must(err)
	if mpSz != int64(len(big)) {
		log.Fatalf("multipart size mismatch: got %d want %d", mpSz, len(big))
	}
	log.Printf("MULTIPART size verified: %d", mpSz)

	url, err := provider.UploadSignedURL(ctx, "s3-smoke/presigned.bin", 60*time.Second)
	must(err)
	log.Printf("PRESIGNED URL: %s", url)

	body := bytes.NewReader([]byte("presigned put body"))
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, body)
	must(err)
	req.ContentLength = int64(body.Len())
	resp, err := http.DefaultClient.Do(req)
	must(err)
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		log.Fatalf("presigned PUT got status %d", resp.StatusCode)
	}
	log.Printf("PRESIGNED PUT OK (status %d)", resp.StatusCode)

	log.Printf("ALL PASSED")
	fmt.Println("OK")
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
