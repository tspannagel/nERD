CREATE VIEW [Sales].[vCustomerOrders]
AS
SELECT c.CustomerId,
       c.Name AS CustomerName,
       o.OrderId,
       o.OrderDate,
       OrderTotal = dbo.fn_OrderTotal(o.OrderId)
FROM   dbo.Customer AS c
       INNER JOIN Sales.[Order] o ON o.CustomerId = c.CustomerId;
