import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

beforeAll(() => {
  const blocked = (): never => {
    throw new Error('AI evals prohibit network access');
  };
  jest.spyOn(http, 'request').mockImplementation(blocked);
  jest.spyOn(http, 'get').mockImplementation(blocked);
  jest.spyOn(https, 'request').mockImplementation(blocked);
  jest.spyOn(https, 'get').mockImplementation(blocked);
  jest.spyOn(net, 'connect').mockImplementation(blocked);
  jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked);
  jest.spyOn(tls, 'connect').mockImplementation(blocked);
  global.fetch = jest.fn(blocked);
});
