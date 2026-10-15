CREATE VIEW Sales.vProductCatalog
WITH SCHEMABINDING
AS
    SELECT p.*, cat.Name AS CategoryName
    FROM Sales.Product p
    LEFT JOIN Sales.Category cat ON cat.CategoryId = p.CategoryId
