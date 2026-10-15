import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadProject, parseSql, readSqlProject } from '../src/parser';
import { globRe } from '../src/parser/sqlproj';

const fixture = path.resolve(__dirname, '../test/fixtures/SampleDb/SampleDb.sqlproj');

test('sdk-style project includes all scripts except deploy scripts', () => {
  const p = readSqlProject(fixture);
  assert.equal(p.name, 'SampleDb');
  assert.equal(p.sdkStyle, true);
  const rel = p.sqlFiles.map((f) => path.relative(p.dir, f).split(path.sep).join('/'));
  assert.ok(rel.includes('Tables/Customer.sql'));
  assert.ok(!rel.includes('Scripts/Seed.sql'));
});

test('glob patterns', () => {
  assert.ok(globRe('**/*.sql').test('a/b/c.sql'));
  assert.ok(globRe('**/*.sql').test('c.sql'));
  assert.ok(globRe('Tables/*.sql').test('tables/x.SQL'));
  assert.ok(!globRe('Tables/*.sql').test('Tables/sub/x.sql'));
});

test('table columns, types, keys, defaults', () => {
  const { objects } = parseSql(`
    CREATE TABLE [dbo].[T] (
      [Id] INT IDENTITY (1, 1) NOT NULL,
      [Price] DECIMAL (18, 2) NULL,
      [Name] NVARCHAR(MAX) CONSTRAINT DF_T DEFAULT (N'x') NOT NULL,
      [Calc] AS (Price * 2) PERSISTED,
      CONSTRAINT [PK_T] PRIMARY KEY CLUSTERED ([Id] ASC)
    )`, 'f.sql');
  const t = objects[0];
  assert.equal(t.id, 'dbo.t');
  assert.deepEqual(t.columns.map((c) => [c.name, c.type, c.nullable, c.isPrimaryKey]), [
    ['Id', 'INT', false, true],
    ['Price', 'DECIMAL(18,2)', true, false],
    ['Name', 'NVARCHAR(MAX)', false, false],
    ['Calc', 'AS (Price * 2) PERSISTED', true, false],
  ]);
  assert.equal(t.columns[0].identity, 'IDENTITY(1,1)');
  assert.equal(t.columns[2].default, "N'x'");
});

test('procedure parameters and function returns', () => {
  const { objects } = parseSql(`
    CREATE PROCEDURE s.p @a INT, @b NVARCHAR(10) = N'x', @c BIGINT OUTPUT AS SELECT 1
    GO
    CREATE FUNCTION dbo.f (@x INT) RETURNS DECIMAL(18, 2) AS BEGIN RETURN 1 END`, 'f.sql');
  const [p, f] = objects;
  assert.equal(p.kind, 'procedure');
  assert.deepEqual(p.parameters.map((x) => [x.name, x.type, !!x.output, x.default]), [
    ['@a', 'INT', false, undefined],
    ['@b', 'NVARCHAR(10)', false, "N'x'"],
    ['@c', 'BIGINT', true, undefined],
  ]);
  assert.equal(f.kind, 'function');
  assert.equal(f.returns, 'DECIMAL(18, 2)');
});

test('sample project model', () => {
  const m = loadProject(fixture);
  const ids = m.objects.map((o) => o.id).sort();
  assert.deepEqual(ids, [
    'dbo.address', 'dbo.customer', 'dbo.fn_customerorders', 'dbo.fn_ordertotal', 'dbo.usp_touchcustomer',
    'sales.category', 'sales.fn_topproducts', 'sales.order', 'sales.orderline', 'sales.product',
    'sales.usp_placeorder', 'sales.vcustomerorders', 'sales.vproductcatalog',
  ]);
  const fks = m.relations.filter((r) => r.kind === 'fk').map((r) => `${r.from}->${r.to}:${r.fromColumns}=${r.toColumns}`).sort();
  assert.deepEqual(fks, [
    'dbo.address->dbo.customer:CustomerId=CustomerId',
    'sales.category->sales.category:ParentId=CategoryId',
    'sales.order->dbo.customer:CustomerId=CustomerId',
    'sales.orderline->sales.order:OrderId=OrderId',
    'sales.orderline->sales.product:ProductId=ProductId',
    'sales.product->sales.category:CategoryId=CategoryId',
  ]);
  const deps = (id: string) => m.objects.find((o) => o.id === id)!.references;
  assert.deepEqual(deps('sales.usp_placeorder'), ['dbo.usp_touchcustomer', 'sales.order', 'sales.orderline', 'sales.product']);
  assert.deepEqual(deps('dbo.usp_touchcustomer'), ['dbo.customer']);
  assert.deepEqual(deps('sales.vcustomerorders'), ['dbo.customer', 'dbo.fn_ordertotal', 'sales.order']);

  const view = m.objects.find((o) => o.id === 'sales.vcustomerorders')!;
  assert.deepEqual(view.columns.map((c) => `${c.name}:${c.type}`), [
    'CustomerId:INT', 'CustomerName:NVARCHAR(200)', 'OrderId:BIGINT', 'OrderDate:DATE', 'OrderTotal:',
  ]);
  const cat = m.objects.find((o) => o.id === 'sales.vproductcatalog')!;
  assert.equal(cat.columns.length, 6);
  const tvf = m.objects.find((o) => o.id === 'sales.fn_topproducts')!;
  assert.deepEqual(tvf.columns.map((c) => c.name), ['ProductId', 'Sold']);
  const order = m.objects.find((o) => o.id === 'sales.order')!;
  assert.equal(order.columns.find((c) => c.name === 'Status')!.type, 'TINYINT');
  assert.deepEqual(m.warnings, []);
});
