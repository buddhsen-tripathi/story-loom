import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

let _client: S3Client | null = null

function getR2Client(): S3Client {
  if (!_client) {
    const accountId = process.env.R2_ACCOUNT_ID
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error("Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)")
    }

    _client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    })
  }
  return _client
}

function getBucket() {
  const bucket = process.env.R2_BUCKET_NAME
  if (!bucket) throw new Error("Missing R2_BUCKET_NAME")
  return bucket
}

/** 7 days in seconds — max allowed by R2 */
const PRESIGN_EXPIRY = 7 * 24 * 60 * 60

/**
 * Upload a video buffer to R2 and return the object key + a presigned GET URL.
 */
export async function uploadVideoClip({
  buffer,
  storyId,
  panelId,
}: {
  buffer: Buffer
  storyId: string
  panelId: string
}): Promise<{ key: string; url: string }> {
  const bucket = getBucket()
  const key = `clips/${storyId}/${panelId}.mp4`
  const client = getR2Client()

  console.log(`[r2] uploading ${key} (${Math.round(buffer.length / 1024)}KB) to bucket "${bucket}"`)

  const putResult = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "video/mp4",
    }),
  )

  console.log(`[r2] upload response`, {
    key,
    httpStatus: putResult.$metadata.httpStatusCode,
    etag: putResult.ETag,
  })

  if (putResult.$metadata.httpStatusCode !== 200) {
    throw new Error(`R2 upload failed with status ${putResult.$metadata.httpStatusCode}`)
  }

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: PRESIGN_EXPIRY },
  )

  console.log(`[r2] presigned URL generated for ${key}`)
  return { key, url }
}

/**
 * Generate a fresh presigned GET URL for an existing R2 object.
 */
export async function getPresignedUrl(key: string): Promise<string> {
  const client = getR2Client()
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    { expiresIn: PRESIGN_EXPIRY },
  )
}
