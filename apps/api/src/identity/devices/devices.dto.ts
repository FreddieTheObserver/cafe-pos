import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
} from '../crypto/secret-token';

const MAX_DEVICE_NAME_LENGTH = 60;

const nameField = z.string().trim().min(1).max(MAX_DEVICE_NAME_LENGTH);

const CreateDeviceSchema = z.strictObject({ name: nameField });

/**
 * Codes are typed by a human off another screen, so the shape is normalised
 * before it is judged: surrounding whitespace and lower case are transcription
 * noise, not a wrong code. What is *not* forgiven is a character outside the
 * alphabet — that can only be a typo, and rejecting it here keeps a doomed
 * lookup off the database and out of the rate limit budget.
 */
const ActivateDeviceSchema = z.strictObject({
  pairingCode: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(
      z
        .string()
        .length(PAIRING_CODE_LENGTH)
        .regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]+$`)),
    ),
});

const UpdateDeviceSchema = z
  .strictObject({
    name: nameField,
    // Retiring a tablet is POST /devices/:id/revoke — a separate, deliberate
    // action, not something reachable by editing a field.
    status: z.enum(['ACTIVE', 'PAUSED']),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'provide at least one of name or status',
  });

const DeviceIdParamSchema = z.strictObject({ id: z.uuid() });

export class CreateDeviceDto extends createZodDto(CreateDeviceSchema) {}
export class ActivateDeviceDto extends createZodDto(ActivateDeviceSchema) {}
export class UpdateDeviceDto extends createZodDto(UpdateDeviceSchema) {}
export class DeviceIdParamDto extends createZodDto(DeviceIdParamSchema) {}
