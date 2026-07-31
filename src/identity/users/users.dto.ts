import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';
import { userRoles } from '../../database/schema/enums';

const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * §6.1: minimum length 10 and no "password rules theater" beyond it — no
 * character-class requirements, which push people toward `Password1!` and buy
 * nothing against an offline attack on an argon2id hash.
 *
 * §6.1 also calls for breached-password rejection. That is deliberately *not*
 * here: it needs an outbound call to a range API plus a policy for what to do
 * when that service is unreachable, and wiring an external dependency into the
 * account-creation path belongs with the rest of §12.4's integrations, not
 * smuggled into the auth phase.
 */
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

const emailField = z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email());

const CreateUserSchema = z.strictObject({
  email: emailField,
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  role: z.enum(userRoles),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

/**
 * §8 requires at least one mutable field: an empty PATCH is a client bug, and
 * answering 200 to it would hide that bug behind a success.
 */
const UpdateUserSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
    role: z.enum(userRoles),
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'provide at least one of displayName, role or isActive',
  });

const UserIdParamSchema = z.strictObject({ id: z.uuid() });

export class CreateUserDto extends createZodDto(CreateUserSchema) {}
export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
export class UserIdParamDto extends createZodDto(UserIdParamSchema) {}
