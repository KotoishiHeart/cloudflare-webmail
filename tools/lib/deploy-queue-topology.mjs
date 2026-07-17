export function verifyQueueTopology(output, role, deployment) {
  const topology = parseQueueTopology(output);
  const expectedName = deployment.resources.queues[role];
  if (topology.name !== expectedName) {
    throw new Error(`Queue lookup did not confirm ${expectedName}`);
  }
  if (deployment.mode === 'initial') {
    if (topology.producers.length > 0 || topology.consumers.length > 0) {
      throw new Error(`initial deployment Queue ${expectedName} is already bound to a Worker`);
    }
    return topology;
  }

  const allowed = allowedWorkers(role, deployment.workers);
  rejectUnexpected(topology.producers, allowed.producers, expectedName, 'producer');
  rejectUnexpected(topology.consumers, allowed.consumers, expectedName, 'consumer');
  return topology;
}

export function parseQueueTopology(output) {
  const name = lineValue(output, 'Queue Name');
  const producers = workerList(output, 'Producers');
  const consumers = workerList(output, 'Consumers');
  const producerCount = integerValue(output, 'Number of Producers');
  const consumerCount = integerValue(output, 'Number of Consumers');
  if (producerCount !== producers.length || consumerCount !== consumers.length) {
    throw new Error('Queue topology counts do not match the listed Worker bindings');
  }
  return { name, producers, consumers };
}

function allowedWorkers(role, workers) {
  if (role === 'inbound') {
    return { producers: [workers.ingest, workers.jobs], consumers: [workers.jobs] };
  }
  if (role === 'outbound') {
    return { producers: [workers.web, workers.jobs], consumers: [workers.jobs] };
  }
  return { producers: [workers.jobs], consumers: [workers.jobs] };
}

function rejectUnexpected(actual, allowed, queue, binding) {
  const unexpected = actual.filter((worker) => !allowed.includes(worker));
  if (unexpected.length > 0) {
    throw new Error(`Queue ${queue} has an unexpected ${binding} Worker: ${unexpected[0]}`);
  }
}

function workerList(output, label) {
  const value = optionalLineValue(output, label);
  if (value === undefined || value === '') return [];
  return value.split(',').map((item) => {
    const match = /^worker:([a-z0-9-]+)$/u.exec(item.trim());
    if (!match) throw new Error(`Queue ${label.toLowerCase()} contain an unsupported binding`);
    return match[1];
  });
}

function integerValue(output, label) {
  const value = Number(lineValue(output, label));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Queue ${label.toLowerCase()} is invalid`);
  }
  return value;
}

function lineValue(output, label) {
  const value = optionalLineValue(output, label);
  if (value === undefined || value === '') throw new Error(`Queue output is missing ${label}`);
  return value;
}

function optionalLineValue(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped}:\\s*(.*)$`, 'imu').exec(output)?.[1]?.trim();
}
