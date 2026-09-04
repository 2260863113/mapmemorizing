import { json, handle } from '../../_lib/http';
import { requireSession } from '../../_lib/guard';
import { toPublicUser } from '../../_lib/rows';

export const onRequestGet = handle(
  requireSession(async (context) => {
    return json({ user: toPublicUser(context.session.user) });
  }),
);
