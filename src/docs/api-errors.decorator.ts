import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

import { ERROR_TABLE, type ErrorKind } from '../errors/error-table.js';
import { ErrorBodyDto } from '../http/dto.js';

/**
 * Documents error responses straight from the error table, so the examples in /docs are the exact
 * constant messages the service returns (test/docs.contract.spec.ts checks it).
 */
export function ApiErrors(...kinds: ErrorKind[]): MethodDecorator & ClassDecorator {
  const byStatus = new Map<number, ErrorKind[]>();
  for (const kind of ['unauthenticated', 'service_unavailable', 'internal', ...kinds] as ErrorKind[]) {
    const status = ERROR_TABLE[kind].status;
    byStatus.set(status, [...new Set([...(byStatus.get(status) ?? []), kind])]);
  }
  return applyDecorators(
    ...[...byStatus.entries()].map(([status, list]) =>
      ApiResponse({
        status,
        description: list.map((k) => `\`${k}\`: ${ERROR_TABLE[k].message}`).join('<br>'),
        type: ErrorBodyDto,
        ...(list.length === 1
          ? {
              example: {
                error: {
                  code: list[0],
                  message: ERROR_TABLE[list[0] as ErrorKind].message,
                  requestId: 'b2c4…',
                },
              },
            }
          : {
              examples: Object.fromEntries(
                list.map((k) => [
                  k,
                  {
                    summary: k,
                    value: { error: { code: k, message: ERROR_TABLE[k].message, requestId: 'b2c4…' } },
                  },
                ])
              ),
            }),
      })
    )
  );
}
