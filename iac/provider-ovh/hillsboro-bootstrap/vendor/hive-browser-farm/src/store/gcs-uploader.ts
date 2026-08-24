import { Storage } from "@google-cloud/storage";
import type { ObjectUploader } from "./replicator.ts";

/**
 * GCS binding for the replicator, deliberately thin.
 *
 * Uploads are conditional on the object not existing (`ifGenerationMatch: 0`).
 * That is belt-and-braces next to the credentials — the service account has no
 * delete permission, so it could not clobber a prior version even if a key
 * collided — but it turns a would-be overwrite into an explicit 412 rather than
 * a silent one.
 */
export function createGcsUploader(opts: {
  bucket: string;
  /** Path to a service-account key. Omit to use ADC (workload identity, gcloud). */
  keyFilename?: string;
  projectId?: string;
}): ObjectUploader {
  const storage = new Storage({
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.keyFilename ? { keyFilename: opts.keyFilename } : {}),
  });
  const bucket = storage.bucket(opts.bucket);

  return {
    async upload(path: string, body: Buffer): Promise<"uploaded" | "already-exists"> {
      try {
        await bucket.file(path).save(body, {
          contentType: "application/json",
          preconditionOpts: { ifGenerationMatch: 0 },
          resumable: false,
        });
        return "uploaded";
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 412 || code === 409) return "already-exists";
        throw err;
      }
    },
  };
}
