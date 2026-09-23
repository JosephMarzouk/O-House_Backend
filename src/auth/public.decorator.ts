import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Opts a route out of the global auth guard. Every other route is locked by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
