import { sendJson, type Route } from './router.ts';

/**
 * The routes the bare host serves.
 *
 * `/health` is the whole v1 surface at this stage. `POST /solve`,
 * `GET /events` (#29) and `GET /answers` (#31) get appended to this list as
 * those tickets land; nothing here needs to change for them.
 *
 * Deliberately says nothing about the machine it runs on — there is no auth on
 * this server, so responses carry no filesystem paths and no config.
 */
export function createHostRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/health',
      handle: ({ res }) => {
        sendJson(res, 200, { status: 'ok', service: 'screen-solver' });
      },
    },
  ];
}
