/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 * @emails oncall+nuclide
 */

import {Observable} from 'rxjs';
import * as child_process from 'child_process';
import * as http from 'http';
import WS from 'ws';
import {observeStream} from 'nuclide-commons/stream';

const PROXY_EXECUTABLE = require.resolve('../../src/util/proxy_executable.js');

describe('proxy_executable', () => {
  const httpServer = http.createServer();
  let wsAddress: string;
  let server: WS.Server;
  let connections: Observable<{ws: WS, url: string}>;

  beforeAll(async () => {
    await new Promise((resolve, reject) => {
      httpServer.listen(0, 'localhost', undefined, error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    wsAddress = `ws://${httpServer.address().address}:${
      httpServer.address().port
    }`;
    server = new WS.Server({
      server: httpServer,
      perMessageDeflate: true,
    });
    connections = Observable.create(observer => {
      const onConnection = (ws, req) => observer.next({ws, req});
      server.on('connection', onConnection);
      server.on('error', error => observer.error(error));
      server.on('close', () => observer.complete());
      () => {
        server.removeListener('connection', onConnection);
      };
    }).map(({ws, req}) => {
      return {ws, url: req.url};
    });
  });

  afterAll(() => {
    httpServer.close();
    server.close();
  });

  function spawn(...args: Array<string>): child_process.ChildProcess {
    const proc = child_process.spawn(
      process.execPath,
      [PROXY_EXECUTABLE, wsAddress, ...args],
      {stdio: ['pipe', 'pipe', 'pipe']},
    );
    return proc;
  }

  function observeMessages(ws: WS): Observable<any> {
    return Observable.create(observer => {
      const onMessage = data => {
        observer.next(JSON.parse(data));
      };
      ws.on('message', onMessage);
      ws.on('close', () => observer.complete());
      return () => {
        ws.removeListener('message', onMessage);
      };
    });
  }

  it('connection - no args', async () => {
    const proc = spawn();
    const {ws, url} = await connections.take(1).toPromise();
    const allMsgs = observeMessages(ws)
      .toArray()
      .toPromise();
    const msgs = observeMessages(ws)
      .take(1)
      .toPromise();
    expect(url).toEqual('/?args=%5B%5D');
    // Note: given the way we started the process, both rows and columns will be undefined
    expect(await msgs).toEqual({ch: 'resize'});
    proc.kill('SIGTERM');
    await new Promise((resolve, reject) => ws.on('close', resolve));
    expect(await allMsgs).toHaveLength(1);
  });

  it('connection - args', async () => {
    const proc = spawn('123', '[abc123](~!@#$%^&*-=_+`\'",.<>/?def');
    const {ws, url} = await connections.take(1).toPromise();
    expect(url).toEqual(
      '/?args=%5B%22123%22%2C%22%5Babc123%5D(~!%40%23%24%25%5E%26*-%3D_%2B%60%27%5C%22%2C.%3C%3E%2F%3Fdef%22%5D',
    );
    proc.kill('SIGTERM');
    await new Promise((resolve, reject) => ws.on('close', resolve));
  });

  it('two connections', async () => {
    const procA = spawn('a');
    const procB = spawn('b');
    const conns = await connections
      .take(2)
      .toArray()
      .toPromise();
    const urls = conns.map(({url}) => url);
    expect(urls.length).toBe(2);
    expect(urls).toContain('/?args=%5B%22a%22%5D');
    expect(urls).toContain('/?args=%5B%22b%22%5D');
    procA.kill('SIGTERM');
    procB.kill('SIGTERM');
    await Promise.all([
      new Promise((resolve, reject) => conns[0].ws.on('close', resolve)),
      new Promise((resolve, reject) => conns[1].ws.on('close', resolve)),
    ]);
  });

  it('stdin', async () => {
    const proc = spawn();
    const {ws} = await connections.take(1).toPromise();
    const allMsgs = observeMessages(ws)
      .toArray()
      .toPromise();
    const msgs = observeMessages(ws)
      .take(2)
      .toArray()
      .toPromise();
    proc.stdin.write('123%abc');
    expect(await msgs).toEqual([
      {ch: 'resize'},
      {ch: 'stdin', data: '123%abc'},
    ]);
    proc.kill('SIGTERM');
    expect((await allMsgs).length).toBe(2);
  });

  it('stdout', async () => {
    const proc = spawn();
    const {ws} = await connections.take(1).toPromise();
    const msgs = observeMessages(ws)
      .toArray()
      .toPromise();
    const stdout = observeStream(proc.stdout)
      .toArray()
      .toPromise();
    const stdout1 = observeStream(proc.stdout)
      .take(1)
      .toPromise();
    ws.send(JSON.stringify({ch: 'stdout', data: 'abc$123'}));
    expect(await stdout1).toEqual('abc$123');
    proc.kill('SIGTERM');
    expect((await msgs).length).toBe(1);
    expect((await stdout).length).toBe(1);
  });

  it('stderr', async () => {
    const proc = spawn();
    const {ws} = await connections.take(1).toPromise();
    const msgs = observeMessages(ws)
      .toArray()
      .toPromise();
    const stderr = observeStream(proc.stderr)
      .toArray()
      .toPromise();
    const stderr1 = observeStream(proc.stderr)
      .take(1)
      .toPromise();
    ws.send(JSON.stringify({ch: 'stderr', data: 'abc$123'}));
    expect(await stderr1).toEqual('abc$123');
    proc.kill('SIGTERM');
    expect((await msgs).length).toBe(1);
    expect((await stderr).length).toBe(1);
  });
});
