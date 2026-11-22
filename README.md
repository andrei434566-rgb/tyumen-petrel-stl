# Petrel STL

Локальный просмотрщик STL для Windows. В комплекте четыре модели по активным ячейкам с кодом `5` из ачимовского, юрского и мелового интервалов. Значение кода нужно сверить с легендой исходного проекта Petrel.

## Запуск

1. Скачайте `PetrelViewer-win-x64.zip` из [последнего релиза](https://github.com/andrei434566-rgb/tyumen-petrel-stl/releases/latest).
2. Распакуйте весь архив и запустите `PetrelViewer.exe`. Папка `STL` рядом с приложением содержит модели, которые появятся в списке слева.
3. Чтобы открыть другой STL с диска, нажмите **Открыть STL**. Перетаскивание мышью вращает модель, `Shift` с перетаскиванием сдвигает её, колёсико меняет масштаб.

Приложение использует Microsoft Edge WebView2 Runtime. Файлы моделей загружаются локально.

## Сборка

Для сборки на Windows нужен .NET 10 SDK. Запустите команду в PowerShell из корня репозитория.

```powershell
dotnet publish .\viewer\PetrelViewer.csproj -c Release -r win-x64 --self-contained true `
  -p:PlatformTarget=x64 -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true -p:DebugType=None -o .\viewer\dist
```

Конвертер `petrel_to_stl.py` читает сетку и дискретное свойство из GRDECL. Список аргументов доступен через `python petrel_to_stl.py --help`.
