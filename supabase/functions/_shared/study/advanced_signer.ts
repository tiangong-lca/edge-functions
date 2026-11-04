import { z } from 'zod';
import { idSchema } from '../../../../contracts/lca-study/v1/common.ts';
import { decodeBase64Url } from '../../../../contracts/lca-study/v3/canonical.ts';
import type { ReportContext } from './advanced_context.ts';
import { StudyFailure } from './protocol.ts';
type SigningKey = { keyId: string; issuerId: string; privateKey: CryptoKey };
export async function configuredAdvancedSigner(
  profile: NonNullable<ReportContext['exportProfile']>,
): Promise<SigningKey> {
  try {
    const raw = Deno.env.get('STUDY_EXPORT_SIGNING_KEY');
    if (!raw) throw new Error('missing');
    const value = z
      .object({ keyId: idSchema, issuerId: idSchema, privateKeyPkcs8: z.string().max(128) })
      .strict()
      .parse(JSON.parse(raw));
    if (value.keyId !== profile.keyId || value.issuerId !== profile.issuerId)
      throw new Error('binding');
    return {
      keyId: value.keyId,
      issuerId: value.issuerId,
      privateKey: await crypto.subtle.importKey(
        'pkcs8',
        decodeBase64Url(value.privateKeyPkcs8, 48),
        { name: 'Ed25519' },
        false,
        ['sign'],
      ),
    };
  } catch {
    throw new StudyFailure('CAPABILITY_UNAVAILABLE', 503, 'report.signer_configuration');
  }
}
