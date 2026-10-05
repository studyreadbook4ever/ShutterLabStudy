NVCC ?= nvcc
CUDA_ARCH ?= native
NVCCFLAGS ?= -O3 -std=c++17 -arch=$(CUDA_ARCH) -lineinfo

.PHONY: all test clean
all: shutter-renderer

shutter-renderer: shutter_renderer.cu
	$(NVCC) $(NVCCFLAGS) $< -o $@

test: shutter-renderer
	./shutter-renderer --self-test

clean:
	rm -f shutter-renderer
